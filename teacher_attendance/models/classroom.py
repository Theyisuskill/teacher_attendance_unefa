# -*- coding: utf-8 -*-
import base64
import io
import logging
import qrcode
import uuid
from markupsafe import Markup
from odoo import models, fields, api
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)

# Horas académicas semanales permitidas por tipo de dedicación (min, max)
# Basado en normativas CNU/UNEFA venezolanas
DEDICATION_CONFIG = {
    'completo':  {'label': 'Tiempo Completo', 'min': 12, 'max': 16},
    'medio':     {'label': 'Medio Tiempo',     'min':  4, 'max': 12},
    'variable':  {'label': 'Tiempo Variable',  'min':  1, 'max':  8},
}

class AttendanceSubject(models.Model):
    _name = 'attendance.subject'
    _description = 'Academic Subject'

    name = fields.Char(string='Subject Name', required=True)
    code = fields.Char(string='Subject Code')

class AttendanceClassroom(models.Model):
    _name = 'attendance.classroom'
    _description = 'Classroom'

    name = fields.Char(string='Classroom Name', required=True)
    code = fields.Char(string='Code', required=True)
    qr_code = fields.Binary(string='QR Code', compute='_compute_qr_code', store=True)
    latitude = fields.Float(string='Latitude', digits=(16, 5))
    longitude = fields.Float(string='Longitude', digits=(16, 5))
    radius = fields.Integer(string='Radius (m)', default=20)
    secret_key = fields.Char(string='Secret Key', readonly=True, index=True,
                             default=lambda self: str(uuid.uuid4()))
    
    check_schedule = fields.Boolean(string='Validate Schedule', default=False)
    tolerance_margin = fields.Integer(string='Tolerance (min)', default=15)
    schedule_ids = fields.One2many('attendance.schedule', 'classroom_id', string='Schedules')

    _sql_constraints = [
        ('code_unique', 'unique(code)', 'The classroom code must be unique!'),
    ]

    @api.depends('secret_key')
    def _compute_qr_code(self):
        for record in self:
            if record.secret_key:
                qr = qrcode.QRCode(version=1, box_size=10, border=4)
                qr.add_data(record.secret_key)
                qr.make(fit=True)
                img = qr.make_image(fill_color="black", back_color="white")
                temp = io.BytesIO()
                img.save(temp, format="PNG")
                record.qr_code = base64.b64encode(temp.getvalue())
            else:
                record.qr_code = False

    def action_download_qr(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': f'/web/content/?model=attendance.classroom&id={self.id}&field=qr_code&download=true&filename={self.name}_QR.png',
            'target': 'new',
        }

class AttendanceSchedule(models.Model):
    _name = 'attendance.schedule'
    _description = 'Classroom Schedule'
    _order = 'day_of_week, start_hour'

    classroom_id = fields.Many2one('attendance.classroom', string='Classroom', ondelete='cascade', required=True)
    subject_id = fields.Many2one('attendance.subject', string='Subject', required=True)
    teacher_id = fields.Many2one('res.users', string='Teacher', required=True)
    section = fields.Char(string='Sección', help="Ej: Sección A, 2do Año Sección 02")
    activity_type = fields.Selection([
        ('clase',    'Clase'),
        ('asesoria', 'Asesoría'),
        ('defensa',  'Defensa'),
    ], string='Tipo de Actividad', default='clase', required=True,
       help="Naturaleza del bloque horario. Los registros de asistencia "
            "heredan este tipo al casar con el bloque, salvo que el docente "
            "elija otro al escanear (p. ej. una defensa no programada).")
    day_of_week = fields.Selection([
        ('0', 'Lunes'), ('1', 'Martes'), ('2', 'Miércoles'),
        ('3', 'Jueves'), ('4', 'Viernes'), ('5', 'Sábado'), ('6', 'Domingo'),
    ], string='Día', required=True)
    start_hour = fields.Float(string='Hora Inicio', required=True)
    end_hour = fields.Float(string='Hora Fin', required=True)
    duration = fields.Float(string='Duración (h)', compute='_compute_duration', store=True)

    # QR del aula vinculado al bloque horario
    qr_code = fields.Binary(
        string='QR del Bloque',
        related='classroom_id.qr_code',
        store=False,
        help="Código QR del aula donde se imparte este bloque horario.",
    )

    @api.model
    def get_qr_card_data(self, schedule_id):
        """Retorna los datos necesarios para renderizar la tarjeta QR del bloque."""
        schedule = self.browse(int(schedule_id))
        if not schedule.exists():
            return {}
        day_names = dict(self._fields['day_of_week'].selection)

        def float_to_hhmm(val):
            h = int(val)
            m = round((val - h) * 60)
            return f'{h:02d}:{m:02d}'

        return {
            'classroom_name': schedule.classroom_id.name,
            'classroom_code': schedule.classroom_id.code,
            'subject_name': schedule.subject_id.name,
            'subject_code': schedule.subject_id.code or '',
            'section': schedule.section or '',
            'teacher_name': schedule.teacher_id.name,
            'day_name': day_names.get(schedule.day_of_week, ''),
            'start_hhmm': float_to_hhmm(schedule.start_hour),
            'end_hhmm': float_to_hhmm(schedule.end_hour),
            'qr_base64': schedule.classroom_id.qr_code.decode() if schedule.classroom_id.qr_code else '',
        }

    @api.depends('start_hour', 'end_hour')
    def _compute_duration(self):
        for r in self:
            r.duration = max(0.0, r.end_hour - r.start_hour)

    @api.constrains('start_hour', 'end_hour')
    def _check_hours(self):
        for record in self:
            if record.start_hour >= record.end_hour:
                raise models.ValidationError(
                    "La hora de fin debe ser posterior a la hora de inicio.")

    # ── Triggers de alerta ──────────────────────────────

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for rec in records:
            rec._check_and_notify_load()
        return records

    def write(self, vals):
        result = super().write(vals)
        if any(f in vals for f in ('teacher_id', 'start_hour', 'end_hour')):
            for rec in self:
                rec._check_and_notify_load()
        return result

    def _check_and_notify_load(self):
        """Envía alerta a coordinadores si el docente se acerca o supera su límite."""
        teacher = self.teacher_id
        ded = teacher.teacher_dedication
        if not ded or ded not in DEDICATION_CONFIG:
            return
        cfg = DEDICATION_CONFIG[ded]
        all_schedules = self.search([('teacher_id', '=', teacher.id)])
        total = sum(all_schedules.mapped('duration'))

        threshold_warn = cfg['max'] * 0.8      # 80 % del máximo → advertencia
        at_max = total >= cfg['max']
        approaching = not at_max and total >= threshold_warn

        if at_max:
            subject = f'🔴 Límite de carga horaria alcanzado — {teacher.name}'
            body = Markup(
                f'<p><strong>Alerta crítica de carga horaria</strong></p>'
                f'<p>El docente <strong>{teacher.name}</strong> '
                f'({cfg["label"]}) ha alcanzado su límite semanal.</p>'
                f'<ul>'
                f'<li>Horas asignadas: <strong>{total:.1f}h</strong></li>'
                f'<li>Máximo permitido: <strong>{cfg["max"]}h</strong></li>'
                f'</ul>'
                f'<p>No se pueden agregar más bloques sin superar el contrato.</p>'
            )
            self._alert_coordinators(subject, body)

        elif approaching:
            subject = f'⚠️ Docente próximo al límite de horas — {teacher.name}'
            remaining = cfg['max'] - total
            body = Markup(
                f'<p><strong>Aviso de carga horaria</strong></p>'
                f'<p>El docente <strong>{teacher.name}</strong> '
                f'({cfg["label"]}) está próximo a su límite semanal.</p>'
                f'<ul>'
                f'<li>Horas asignadas: <strong>{total:.1f}h</strong></li>'
                f'<li>Máximo permitido: <strong>{cfg["max"]}h</strong></li>'
                f'<li>Horas restantes: <strong>{remaining:.1f}h</strong></li>'
                f'</ul>'
            )
            self._alert_coordinators(subject, body)

    def _alert_coordinators(self, subject, body):
        """Notifica por inbox a todos los coordinadores y administradores activos."""
        coord_grp = self.env.ref('teacher_attendance.group_coordinator', raise_if_not_found=False)
        admin_grp = self.env.ref('teacher_attendance.group_admin', raise_if_not_found=False)

        group_ids = [g.id for g in [coord_grp, admin_grp] if g]
        if not group_ids:
            return

        coordinators = self.env['res.users'].sudo().search([
            ('active', '=', True),
            ('group_ids', 'in', group_ids),
        ])
        if not coordinators:
            return

        partner_ids = coordinators.mapped('partner_id').ids
        try:
            self.env['mail.thread'].sudo().message_notify(
                partner_ids=partner_ids,
                body=body,
                subject=subject,
                subtype_xmlid='mail.mt_note',
            )
        except Exception as exc:
            _logger.warning("No se pudo enviar alerta de carga horaria: %s", exc)

    @api.model
    def check_teacher_load_compliance(self):
        """Cron diario: verifica que todos los docentes cumplan con el mínimo de horas.
        Envía alertas a coordinadores por cada docente con carga incompleta."""
        teachers_with_dedication = self.env['res.users'].sudo().search([
            ('teacher_dedication', '!=', False),
            ('attendance_role', 'in', ['teacher', 'coordinator', 'admin']),
            ('active', '=', True),
        ])

        alerts = []
        for teacher in teachers_with_dedication:
            ded = teacher.teacher_dedication
            if ded not in DEDICATION_CONFIG:
                continue
            cfg = DEDICATION_CONFIG[ded]
            schedules = self.search([('teacher_id', '=', teacher.id)])
            total = sum(schedules.mapped('duration'))

            if total < cfg['min']:
                alerts.append((teacher, total, cfg))

        if not alerts:
            _logger.info("Cron carga horaria: todos los docentes cumplen el mínimo.")
            return

        # Construir mensaje consolidado
        rows = ''.join(
            f'<tr>'
            f'<td style="padding:4px 8px">{t.name}</td>'
            f'<td style="padding:4px 8px">{c["label"]}</td>'
            f'<td style="padding:4px 8px;color:#d69e2e"><strong>{h:.1f}h</strong></td>'
            f'<td style="padding:4px 8px">{c["min"]}h – {c["max"]}h</td>'
            f'</tr>'
            for t, h, c in alerts
        )
        body = Markup(
            f'<p><strong>⚠️ Reporte diario: docentes con carga horaria incompleta</strong></p>'
            f'<p>Los siguientes docentes aún no han completado la asignación mínima de horas:</p>'
            f'<table border="1" style="border-collapse:collapse;width:100%;font-size:13px">'
            f'<thead><tr style="background:#5273A8;color:#fff">'
            f'<th style="padding:6px 8px">Docente</th>'
            f'<th style="padding:6px 8px">Dedicación</th>'
            f'<th style="padding:6px 8px">Asignadas</th>'
            f'<th style="padding:6px 8px">Rango</th>'
            f'</tr></thead>'
            f'<tbody>{rows}</tbody>'
            f'</table>'
            f'<p style="color:#718096;font-size:11px">Generado automáticamente por el sistema de asistencia UNEFA.</p>'
        )
        subject = f'⚠️ {len(alerts)} docente(s) con carga horaria incompleta — Verificación diaria'
        self._alert_coordinators(subject, body)
        _logger.info("Cron carga horaria: %d alerta(s) enviadas.", len(alerts))

    @api.constrains('teacher_id', 'start_hour', 'end_hour')
    def _check_dedication_hours(self):
        """Valida que el total de horas asignadas no exceda el máximo de la dedicación."""
        for rec in self:
            dedication = rec.teacher_id.teacher_dedication
            if not dedication or dedication not in DEDICATION_CONFIG:
                continue  # sin dedicación definida → sin restricción

            cfg = DEDICATION_CONFIG[dedication]
            # Sumar TODAS las horas del docente (incluye el registro actual)
            all_schedules = self.search([('teacher_id', '=', rec.teacher_id.id)])
            total = sum(all_schedules.mapped('duration'))

            if total > cfg['max']:
                raise ValidationError(
                    f'El docente {rec.teacher_id.name} ({cfg["label"]}) '
                    f'tiene {total:.1f}h semanales asignadas, '
                    f'superando el máximo de {cfg["max"]}h permitidas para su dedicación. '
                    f'Reduzca la carga horaria antes de continuar.'
                )

    @api.model
    def get_teachers_load_summary(self):
        """Retorna el resumen de carga horaria de todos los docentes con dedicación asignada.
        Usado por el ScheduleManager OWL para mostrar indicadores de cumplimiento."""
        schedules = self.search([])
        # Agrupar por docente
        totals = {}
        for s in schedules:
            tid = s.teacher_id.id
            if tid not in totals:
                totals[tid] = {
                    'teacher_id': tid,
                    'teacher_name': s.teacher_id.name,
                    'dedication': s.teacher_id.teacher_dedication,
                    'total_hours': 0.0,
                }
            totals[tid]['total_hours'] += s.duration or 0.0

        # Agregar config de límites
        result = []
        for data in totals.values():
            ded = data['dedication']
            cfg = DEDICATION_CONFIG.get(ded, {})
            result.append({
                **data,
                'min_hours': cfg.get('min', 0),
                'max_hours': cfg.get('max', 999),
                'ded_label': cfg.get('label', ''),
                'status': (
                    'over'  if data['total_hours'] > cfg.get('max', 999) else
                    'under' if ded and data['total_hours'] < cfg.get('min', 0) else
                    'ok'
                ),
            })
        return result

    @api.constrains('teacher_id', 'day_of_week', 'start_hour', 'end_hour')
    def _check_teacher_overlap(self):
        """Impide que un docente tenga dos bloques solapados el mismo día."""
        for rec in self:
            overlapping = self.search([
                ('teacher_id', '=', rec.teacher_id.id),
                ('day_of_week', '=', rec.day_of_week),
                ('id', '!=', rec.id),
                ('start_hour', '<', rec.end_hour),
                ('end_hour', '>', rec.start_hour),
            ], limit=1)
            if overlapping:
                day_name = dict(self._fields['day_of_week'].selection)[rec.day_of_week]
                raise models.ValidationError(
                    f'El docente {rec.teacher_id.name} ya tiene un bloque asignado '
                    f'el {day_name} de '
                    f'{int(overlapping.start_hour):02d}:{round((overlapping.start_hour % 1)*60):02d} '
                    f'a '
                    f'{int(overlapping.end_hour):02d}:{round((overlapping.end_hour % 1)*60):02d} '
                    f'en "{overlapping.classroom_id.name}". '
                    f'Seleccione un horario diferente.'
                )
