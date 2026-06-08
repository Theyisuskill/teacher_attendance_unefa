# -*- coding: utf-8 -*-
import math
import datetime
import pytz
from odoo import models, fields, api, _
from odoo.exceptions import AccessError, UserError

# Tipos de actividad académica para discriminar las horas ejecutadas
ACTIVITY_TYPES = [
    ('clase',    'Clase'),
    ('asesoria', 'Asesoría'),
    ('defensa',  'Defensa'),
]

# Mapeo inteligente de justificación: estatus origen → estatus justificado.
# Incluye los justificados a sí mismos para permitir re-edición de la justificación.
JUSTIFY_TARGET = {
    'late':             'late_justified',
    'absent':           'absent_justified',
    'late_justified':   'late_justified',
    'absent_justified': 'absent_justified',
}
# Reversión: estatus justificado → estatus original
JUSTIFY_REVERT = {
    'late_justified':   'late',
    'absent_justified': 'absent',
}

# Parámetros de configuración de métodos de registro
METHOD_PARAMS = {
    'qr': 'teacher_attendance.method_qr_enabled',
    'carnet': 'teacher_attendance.method_carnet_enabled',
    'kiosk': 'teacher_attendance.method_kiosk_enabled',
    'device_validation': 'teacher_attendance.device_validation_enabled',
}
# Defaults: métodos habilitados, validación de dispositivo apagada
METHOD_DEFAULTS = {
    'qr': True,
    'carnet': True,
    'kiosk': True,
    'device_validation': False,
}


class AttendanceLog(models.Model):
    _name = 'attendance.log'
    _description = 'Attendance Log'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'check_in desc'

    teacher_id = fields.Many2one('res.users', string='Teacher', required=True, default=lambda self: self.env.user, tracking=True)
    classroom_id = fields.Many2one('attendance.classroom', string='Classroom', required=True, tracking=True)
    subject_id = fields.Many2one('attendance.subject', string='Subject', tracking=True)
    section = fields.Char(string='Sección', help="Sección heredada del bloque de horario casado.")
    is_substitution = fields.Boolean(string='Is Substitution', default=False)
    temp_block_id = fields.Many2one(
        'attendance.temp.block', string='Bloque Temporal', readonly=True,
        ondelete='set null', index=True,
        help="Bloque de actividad no rutinaria desde el que se registró esta asistencia.")
    activity_type = fields.Selection(
        ACTIVITY_TYPES, string='Tipo de Actividad', default='clase',
        required=True, tracking=True,
        help="Clasifica el tiempo ejecutado. Se hereda del bloque de horario "
             "casado; si el docente lo elige al escanear, prevalece su elección.")

    check_in = fields.Datetime(string='Check-in Time', default=fields.Datetime.now, readonly=True, tracking=True)
    check_out = fields.Datetime(string='Check-out Time', readonly=True, tracking=True)
    duration = fields.Float(string='Duration (Hours)', compute='_compute_duration', store=True)

    latitude = fields.Float(string='Latitude', digits=(16, 5))
    longitude = fields.Float(string='Longitude', digits=(16, 5))
    distance = fields.Float(string='Distance (m)', compute='_compute_distance', store=True)
    signature = fields.Binary(string='Signature')
    justification = fields.Text(string='Justification', tracking=True)
    evidence = fields.Binary(string='Evidence Attachment')

    method = fields.Selection([
        ('qr', 'QR de Aula'),
        ('carnet', 'Carnet (Cédula)'),
        ('kiosk', 'Kiosko PIN'),
        ('manual', 'Manual'),
    ], string='Método de Registro', default='manual', readonly=True, tracking=True)

    device_id = fields.Char(string='Dispositivo', readonly=True,
                            help="Identificador del dispositivo desde el que se registró la asistencia.")

    status = fields.Selection([
        ('valid',   'Asistió'),
        ('late',    'Retardo'),
        ('absent',  'Inasistencia'),
        ('outside', 'Fuera del Radio'),
        ('manual',  'Validado Manual'),
        ('invalid', 'Inválido'),
        ('late_justified',   'Retardo Justificado'),
        ('absent_justified', 'Falta Justificada'),
    ], string='Estatus', compute='_compute_status', store=True, readonly=False, tracking=True)

    # ── Justificación aprobada por Coordinación ──────────
    justification_aval = fields.Char(
        string='Número de Aval', tracking=True,
        help="Número del aval o soporte que respalda la justificación.")
    justification_reason = fields.Text(
        string='Motivo de Justificación', tracking=True,
        help="Motivo por el cual la Coordinación justifica el retardo o la falta.")
    justification_approver_id = fields.Many2one(
        'res.users', string='Justificado por', readonly=True, tracking=True,
        help="Usuario de Coordinación que aprobó la justificación.")
    justification_date = fields.Datetime(
        string='Fecha de Justificación', readonly=True, tracking=True)

    def _match_teacher_schedule(self):
        """Bloque de horario que casa con este registro (mismo aula, docente y
        día de la semana), o un recordset vacío. Reutiliza la misma lógica de
        casado que el motor de estatus, sin tocarla."""
        self.ensure_one()
        if not (self.check_in and self.classroom_id and self.teacher_id):
            return self.env['attendance.schedule']
        local_time = fields.Datetime.context_timestamp(self, self.check_in)
        current_day = str(local_time.weekday())
        return self.classroom_id.schedule_ids.filtered(
            lambda s: s.day_of_week == current_day and s.teacher_id == self.teacher_id
        )[:1]

    @api.model_create_multi
    def create(self, vals_list):
        """Modelo híbrido del tipo de actividad: si NO se especifica
        explícitamente al crear (p. ej. el docente eligió un tipo en el scanner),
        se hereda del bloque de horario casado. Sin bloque → queda en 'clase'."""
        records = super().create(vals_list)
        for rec, vals in zip(records, vals_list):
            if 'activity_type' not in vals:
                sched = rec._match_teacher_schedule()
                if sched.activity_type:
                    rec.activity_type = sched.activity_type
        return records

    @api.depends('check_in', 'check_out')
    def _compute_duration(self):
        for log in self:
            if log.check_in and log.check_out:
                diff = log.check_out - log.check_in
                log.duration = diff.total_seconds() / 3600.0
            else:
                log.duration = 0.0

    @api.depends('latitude', 'longitude', 'classroom_id')
    def _compute_distance(self):
        for log in self:
            if log.latitude and log.longitude and log.classroom_id:
                R = 6371e3
                phi1 = math.radians(log.latitude)
                phi2 = math.radians(log.classroom_id.latitude)
                delta_phi = math.radians(log.classroom_id.latitude - log.latitude)
                delta_lambda = math.radians(log.classroom_id.longitude - log.longitude)
                a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                log.distance = R * c
            else:
                log.distance = 0.0

    @api.depends('distance', 'classroom_id', 'check_in', 'teacher_id', 'temp_block_id')
    def _compute_status(self):
        """Motor de reglas de asistencia.

        Prioridad de evaluación:
        1. Manual / Ausencia generada → no tocar
        2. GPS fuera del radio → 'outside' (Fuera del Radio)
        3. Sin validación de horario → 'valid' (Asistió)
        4. Suplencia autorizada → 'valid' (Asistió)
        5. Docente SIN horario en ese aula/día → 'late' (Retardo — fuera de horario)
        6. Llegó dentro del margen de tolerancia → 'valid' (Asistió)
        7. Llegó después del margen pero antes del fin → 'late' (Retardo)
        8. Llegó después del fin de clase → 'late' (Retardo tardío)
        """
        for log in self:
            # Regla 0: No recalcular registros manuales, de ausencia ni justificados
            if log.status in ('manual', 'absent', 'late_justified', 'absent_justified'):
                continue

            # Regla 0.b: Bloque temporal (actividad no rutinaria).
            # La ventana de tiempo ya se validó al escanear el QR; aquí solo
            # se evalúa el GPS si el bloque lo exige. Nunca es 'retardo'.
            if log.temp_block_id:
                if log.temp_block_id.require_gps and log.distance > log.classroom_id.radius:
                    log.status = 'outside'
                else:
                    log.status = 'valid'
                continue

            # Regla 1: Distancia GPS
            if log.distance > log.classroom_id.radius:
                log.status = 'outside'
                continue

            # Regla 2: Aula sin validación de horario → siempre Asistió
            if not log.classroom_id.check_schedule:
                log.status = 'valid'
                continue

            # Convertir check_in a hora local del usuario
            local_time = fields.Datetime.context_timestamp(log, log.check_in)
            current_day  = str(local_time.weekday())
            current_hour = local_time.hour + (local_time.minute / 60.0)
            tolerance_h  = log.classroom_id.tolerance_margin / 60.0

            # Regla 3: Suplencia autorizada
            sub = self.env['attendance.substitution'].search([
                ('classroom_id',        '=', log.classroom_id.id),
                ('substitute_teacher_id', '=', log.teacher_id.id),
                ('date',                '=', local_time.date()),
                ('state',               '=', 'active'),
            ], limit=1)
            if sub:
                log.subject_id    = sub.subject_id
                log.is_substitution = True
                log.status        = 'valid'
                continue

            # Regla 4: Buscar horario del docente en este aula este día
            teacher_schedule = log.classroom_id.schedule_ids.filtered(
                lambda s: s.day_of_week == current_day and s.teacher_id == log.teacher_id
            )

            if not teacher_schedule:
                # Sin horario asignado → Retardo (vino fuera de su bloque)
                log.status = 'late'
                continue

            sched = teacher_schedule[0]
            log.subject_id = sched.subject_id
            log.section = sched.section

            on_time_limit = sched.start_hour + tolerance_h  # hasta aquí = Asistió

            # Regla 5: Puntualidad
            if current_hour <= on_time_limit:
                log.status = 'valid'   # Asistió (dentro de la tolerancia)
            else:
                log.status = 'late'    # Retardo (llegó después de la tolerancia)

    # ─────────────────────────────────────────────
    # Configuración de métodos de registro
    # ─────────────────────────────────────────────
    @api.model
    def get_method_config(self):
        """Retorna el estado (habilitado/deshabilitado) de cada método de registro."""
        icp = self.env['ir.config_parameter'].sudo()
        return {
            key: icp.get_param(param, str(METHOD_DEFAULTS[key])) == 'True'
            for key, param in METHOD_PARAMS.items()
        }

    @api.model
    def set_method_config(self, key, value):
        """Habilita/deshabilita un método de registro. Solo coordinadores/admins."""
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo los coordinadores pueden modificar los métodos de registro.'))
        if key not in METHOD_PARAMS:
            raise AccessError(_('Método de registro desconocido: %s') % key)
        self.env['ir.config_parameter'].sudo().set_param(
            METHOD_PARAMS[key], 'True' if value else 'False')
        return True

    def _method_disabled_response(self, label):
        return {'status': 'invalid',
                'message': _('El registro por %s está deshabilitado por el coordinador.') % label}

    # ─────────────────────────────────────────────
    # Registro por QR de aula (scanner del docente)
    # ─────────────────────────────────────────────
    @api.model
    def action_log_attendance(self, secret_key, latitude, longitude, signature=None, device_id=None, activity_type=None):
        config = self.get_method_config()
        if not config['qr']:
            return self._method_disabled_response(_('QR de aula'))

        # Validación de dispositivo vinculado
        if config['device_validation']:
            if not device_id:
                return {'status': 'invalid',
                        'message': _('No se pudo identificar el dispositivo. Actualice la página e intente de nuevo.')}
            user = self.env.user
            if not user.attendance_device_id:
                # Primer registro: vincular este dispositivo al usuario
                user.sudo().attendance_device_id = device_id
            elif user.attendance_device_id != device_id:
                return {'status': 'invalid',
                        'message': _('Este dispositivo no está autorizado para registrar su asistencia. '
                                     'Debe usar su dispositivo habitual o pedir al coordinador que libere el vínculo.')}

        classroom = self.env['attendance.classroom'].search([('secret_key', '=', secret_key)], limit=1)
        if not classroom:
            return {'status': 'invalid', 'message': _('Invalid QR Code.')}

        active_log = self.search([
            ('teacher_id', '=', self.env.uid),
            ('classroom_id', '=', classroom.id),
            ('check_out', '=', False),
            ('status', '!=', 'absent'),
            ('check_in', '>', fields.Datetime.now() - datetime.timedelta(hours=12))
        ], limit=1)

        # Timestamp del servidor — explícito para garantizar hora centralizada
        server_now = fields.Datetime.now()

        if active_log:
            active_log.write({'check_out': server_now})
            return {
                'status': 'valid',
                'message': _('Check-out successful!'),
                'server_time': fields.Datetime.to_string(server_now),
            }

        vals = {
            'teacher_id': self.env.uid,
            'classroom_id': classroom.id,
            'check_in': server_now,          # EXPLÍCITO: hora del servidor, no del dispositivo
            'latitude': latitude,
            'longitude': longitude,
            'method': 'qr',
            'device_id': device_id or False,
        }
        # Híbrido: solo si el docente eligió un tipo explícito en el scanner.
        # Si no, create() lo hereda del bloque de horario casado.
        if activity_type in dict(ACTIVITY_TYPES):
            vals['activity_type'] = activity_type
        if signature:
            if ',' in signature: signature = signature.split(',')[1]
            vals['signature'] = signature
        log = self.create(vals)
        return {
            'status': log.status,
            'message': _('Check-in successful!') if log.status == 'valid' else _('Check-in outside of parameters.'),
            'server_time': fields.Datetime.to_string(server_now),
        }

    # ─────────────────────────────────────────────
    # Registro por QR de bloque temporal (no rutinario)
    # ─────────────────────────────────────────────
    @api.model
    def action_log_temp_block(self, token, latitude=0, longitude=0, signature=None, device_id=None):
        """Registra entrada/salida en un bloque de asistencia temporal.

        El token del QR identifica el bloque. El registro es válido solo dentro
        de la ventana del bloque (con margen). El tiempo se suma al renglón
        (activity_type) del bloque. Abierto a cualquier docente autenticado.
        """
        if not self.get_method_config()['qr']:
            return self._method_disabled_response(_('QR de aula'))

        block = self.env['attendance.temp.block'].sudo().search(
            [('token', '=', token), ('active', '=', True)], limit=1)
        if not block:
            return {'status': 'invalid',
                    'message': _('Código QR de bloque temporal inválido o desactivado.')}

        now = fields.Datetime.now()
        lead = datetime.timedelta(minutes=15)
        grace = datetime.timedelta(minutes=30)
        if block.date_start and now < block.date_start - lead:
            return {'status': 'invalid',
                    'message': _('El bloque «%s» aún no está disponible para registro.') % block.name}
        if block.date_end and now > block.date_end + grace:
            return {'status': 'invalid',
                    'message': _('El bloque «%s» ya finalizó. Registro cerrado.') % block.name}

        active_log = self.search([
            ('teacher_id', '=', self.env.uid),
            ('temp_block_id', '=', block.id),
            ('check_out', '=', False),
            ('status', '!=', 'absent'),
        ], limit=1)

        server_now = now
        if active_log:
            active_log.write({'check_out': server_now})
            return {
                'status': 'checkout',
                'message': _('Salida registrada de «%s».') % block.name,
                'server_time': fields.Datetime.to_string(server_now),
            }

        vals = {
            'teacher_id': self.env.uid,
            'classroom_id': block.classroom_id.id,
            'temp_block_id': block.id,
            'subject_id': block.subject_id.id or False,
            'activity_type': block.activity_type,   # explícito → no se hereda del horario
            'check_in': server_now,
            'latitude': latitude,
            'longitude': longitude,
            'method': 'qr',
            'device_id': device_id or False,
        }
        if signature:
            if ',' in signature:
                signature = signature.split(',')[1]
            vals['signature'] = signature
        log = self.create(vals)
        type_label = dict(ACTIVITY_TYPES).get(block.activity_type, '')
        if log.status == 'outside':
            msg = _('Registrado en «%s», pero fuera del radio del aula — será revisado.') % block.name
        else:
            msg = _('Entrada registrada en «%s» (%s).') % (block.name, type_label)
        return {
            'status': log.status,
            'message': msg,
            'server_time': fields.Datetime.to_string(server_now),
        }

    @api.model
    def get_teacher_stats(self):
        today = fields.Date.today()
        first_day = today.replace(day=1)
        logs = self.search([('teacher_id', '=', self.env.uid), ('check_in', '>=', first_day)])
        total_hours = sum(logs.mapped('duration'))
        valid_count = len(logs.filtered(lambda l: l.status in ['valid', 'manual']))
        total_count = len(logs)
        punctuality = (valid_count / total_count * 100) if total_count > 0 else 100
        return {'total_hours': round(total_hours, 2), 'punctuality': round(punctuality, 1), 'total_logs': total_count}

    # ─────────────────────────────────────────────
    # Reporte: Horas Acumuladas Ejecutadas por tipo
    # ─────────────────────────────────────────────
    @api.model
    def get_executed_hours_report(self, date_from, date_to):
        """Horas ejecutadas (reales) por docente, discriminadas por tipo de
        actividad: Clase, Asesoría y Defensa.

        'Ejecutadas' = registros con duración real (check-out efectuado) y
        estatus de presencia efectiva ('valid', 'late', 'manual'). Se excluyen
        inasistencias, registros fuera de radio e inválidos.

        Solo coordinadores/administradores.

        Returns:
            {
              'rows': [ {teacher_id, teacher_name, clase, asesoria, defensa, total}, ... ],
              'totals': {clase, asesoria, defensa, total},
              'date_from': str, 'date_to': str,
            }
        """
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo los coordinadores pueden consultar el reporte de horas ejecutadas.'))

        domain = [
            ('check_in', '>=', '%s 00:00:00' % date_from),
            ('check_in', '<=', '%s 23:59:59' % date_to),
            ('check_out', '!=', False),
            ('status', 'in', ['valid', 'late', 'manual', 'late_justified']),
        ]
        groups = self.read_group(
            domain,
            ['duration:sum'],
            ['teacher_id', 'activity_type'],
            lazy=False,
        )

        valid_types = dict(ACTIVITY_TYPES)
        rows = {}
        totals = {'clase': 0.0, 'asesoria': 0.0, 'defensa': 0.0, 'total': 0.0}

        for g in groups:
            if not g.get('teacher_id'):
                continue
            tid, tname = g['teacher_id']
            atype = g.get('activity_type') or 'clase'
            if atype not in valid_types:
                atype = 'clase'
            hours = g.get('duration') or 0.0
            if tid not in rows:
                rows[tid] = {
                    'teacher_id': tid, 'teacher_name': tname,
                    'clase': 0.0, 'asesoria': 0.0, 'defensa': 0.0, 'total': 0.0,
                }
            rows[tid][atype] += hours
            rows[tid]['total'] += hours
            totals[atype] += hours
            totals['total'] += hours

        result_rows = sorted(rows.values(), key=lambda r: r['teacher_name'].lower())
        for r in result_rows:
            for k in ('clase', 'asesoria', 'defensa', 'total'):
                r[k] = round(r[k], 2)
        for k in totals:
            totals[k] = round(totals[k], 2)

        return {
            'rows': result_rows,
            'totals': totals,
            'date_from': date_from,
            'date_to': date_to,
        }

    # ─────────────────────────────────────────────
    # Generador de reportes estadísticos estructurables
    # ─────────────────────────────────────────────
    @api.model
    def get_report_filter_options(self):
        """Opciones para los filtros del generador de reportes."""
        self._ensure_coordinator(_('generar reportes'))
        teachers = self.env['res.users'].search_read(
            [('attendance_role', 'in', ['teacher', 'coordinator', 'admin'])],
            ['name'], order='name asc')
        subjects = self.env['attendance.subject'].search_read([], ['name', 'code'], order='name asc')
        # Secciones: unión de las definidas en horarios y las presentes en registros
        sched_secs = self.env['attendance.schedule'].search([]).mapped('section')
        log_secs = [g['section'] for g in self.read_group(
            [('section', '!=', False)], ['section'], ['section']) if g.get('section')]
        sections = sorted({s for s in (sched_secs + log_secs) if s})
        statuses = [{'value': v, 'label': l} for v, l in self._fields['status'].selection]
        return {'teachers': teachers, 'subjects': subjects, 'sections': sections, 'statuses': statuses}

    @api.model
    def generate_report(self, date_from, date_to, group_by='month', filters=None):
        """Genera un reporte estadístico estructurable y filtrable.

        Args:
            date_from, date_to (str): rango 'YYYY-MM-DD'.
            group_by (str): día/semana/mes/trimestre/año o docente/asignatura/sección/estatus.
            filters (dict): teacher_id, subject_id, section, statuses (lista).

        Returns: {group_by, status_labels, rows:[{key,label,counts,total,hours,punctuality}], totals}
        """
        self._ensure_coordinator(_('generar reportes'))
        filters = filters or {}

        domain = [
            ('check_in', '>=', '%s 00:00:00' % date_from),
            ('check_in', '<=', '%s 23:59:59' % date_to),
        ]
        if filters.get('teacher_id'):
            domain.append(('teacher_id', '=', int(filters['teacher_id'])))
        if filters.get('subject_id'):
            domain.append(('subject_id', '=', int(filters['subject_id'])))
        if filters.get('section'):
            domain.append(('section', '=', filters['section']))
        if filters.get('statuses'):
            domain.append(('status', 'in', filters['statuses']))

        logs = self.search(domain)

        MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
        STATUS_KEYS = ['valid', 'late', 'absent', 'outside', 'manual',
                       'late_justified', 'absent_justified', 'invalid']
        status_labels = dict(self._fields['status'].selection)
        TIME_GROUPS = ('day', 'week', 'month', 'quarter', 'year')

        groups = {}

        def get_group(key, label, sk):
            if key not in groups:
                groups[key] = {'key': key, 'label': label, '_sk': sk,
                               'counts': {k: 0 for k in STATUS_KEYS},
                               'total': 0, 'hours': 0.0}
            return groups[key]

        for log in logs:
            local = fields.Datetime.context_timestamp(self, log.check_in) if log.check_in else None
            if group_by in TIME_GROUPS:
                if not local:
                    continue
                if group_by == 'day':
                    key = local.strftime('%Y-%m-%d'); label = local.strftime('%d/%m/%Y'); sk = key
                elif group_by == 'week':
                    iso = local.isocalendar()
                    key = '%04d-W%02d' % (iso[0], iso[1])
                    label = 'Sem %02d / %04d' % (iso[1], iso[0]); sk = key
                elif group_by == 'month':
                    key = '%04d-%02d' % (local.year, local.month)
                    label = '%s %04d' % (MESES[local.month - 1], local.year); sk = key
                elif group_by == 'quarter':
                    q = (local.month - 1) // 3 + 1
                    key = '%04d-Q%d' % (local.year, q)
                    label = '%dº Trimestre %04d' % (q, local.year); sk = key
                else:  # year
                    key = '%04d' % local.year; label = key; sk = key
            elif group_by == 'teacher':
                key = 't-%s' % (log.teacher_id.id or 0)
                label = log.teacher_id.name or '(Sin docente)'; sk = label.lower()
            elif group_by == 'subject':
                key = 's-%s' % (log.subject_id.id or 0)
                label = log.subject_id.name or '(Sin asignatura)'; sk = label.lower()
            elif group_by == 'section':
                label = log.section or '(Sin sección)'; key = 'sec-%s' % (log.section or '∅'); sk = label.lower()
            elif group_by == 'status':
                key = log.status or 'invalid'
                label = status_labels.get(log.status, log.status or '—'); sk = key
            else:
                key = 'all'; label = 'Total'; sk = ''

            g = get_group(key, label, sk)
            st = log.status or 'invalid'
            g['counts'].setdefault(st, 0)
            g['counts'][st] += 1
            g['total'] += 1
            g['hours'] += log.duration or 0.0

        rows = sorted(groups.values(), key=lambda r: r['_sk'])
        totals_counts = {k: 0 for k in STATUS_KEYS}
        total_n, total_h = 0, 0.0
        for r in rows:
            for k, v in r['counts'].items():
                totals_counts.setdefault(k, 0)
                totals_counts[k] += v
            total_n += r['total']
            total_h += r['hours']
            ok = r['counts'].get('valid', 0) + r['counts'].get('manual', 0)
            r['punctuality'] = round(ok / r['total'] * 100, 1) if r['total'] else 0.0
            r['hours'] = round(r['hours'], 2)
            r.pop('_sk', None)

        ok_t = totals_counts.get('valid', 0) + totals_counts.get('manual', 0)
        totals = {
            'counts': totals_counts,
            'total': total_n,
            'hours': round(total_h, 2),
            'punctuality': round(ok_t / total_n * 100, 1) if total_n else 0.0,
        }
        return {'group_by': group_by, 'status_labels': status_labels,
                'rows': rows, 'totals': totals}

    @api.model
    def get_report_detail(self, date_from, date_to, filters=None):
        """Detalle fila-por-fila de los registros (la representación más fiel de
        lo almacenado), con los mismos filtros del generador. Coordinación."""
        self._ensure_coordinator(_('exportar reportes'))
        filters = filters or {}
        domain = [
            ('check_in', '>=', '%s 00:00:00' % date_from),
            ('check_in', '<=', '%s 23:59:59' % date_to),
        ]
        if filters.get('teacher_id'):
            domain.append(('teacher_id', '=', int(filters['teacher_id'])))
        if filters.get('subject_id'):
            domain.append(('subject_id', '=', int(filters['subject_id'])))
        if filters.get('section'):
            domain.append(('section', '=', filters['section']))
        if filters.get('statuses'):
            domain.append(('status', 'in', filters['statuses']))

        status_labels = dict(self._fields['status'].selection)
        method_labels = dict(self._fields['method'].selection)
        act_labels = dict(ACTIVITY_TYPES)

        rows = []
        for l in self.search(domain, order='check_in desc'):
            ci = fields.Datetime.context_timestamp(self, l.check_in) if l.check_in else None
            co = fields.Datetime.context_timestamp(self, l.check_out) if l.check_out else None
            rows.append({
                'teacher': l.teacher_id.name or '',
                'subject': l.subject_id.name or '',
                'section': l.section or '',
                'activity_type': act_labels.get(l.activity_type, ''),
                'date': ci.strftime('%d/%m/%Y') if ci else '',
                'check_in': ci.strftime('%H:%M') if ci else '',
                'check_out': co.strftime('%H:%M') if co else '',
                'hours': round(l.duration or 0.0, 2),
                'method': method_labels.get(l.method, l.method or ''),
                'status': status_labels.get(l.status, l.status or ''),
                'aval': l.justification_aval or '',
                'approver': l.justification_approver_id.name or '',
            })
        return {'rows': rows, 'date_from': date_from, 'date_to': date_to}

    # ─────────────────────────────────────────────
    # Justificación de Retardos / Faltas (Coordinación)
    # ─────────────────────────────────────────────
    def _ensure_coordinator(self, action_label):
        """Verifica que el usuario actual sea coordinador o administrador."""
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo la Coordinación puede %s.') % action_label)

    @api.model
    def action_justify_records(self, record_ids, reason, aval_number):
        """Justifica en lote los registros seleccionados (Coordinación).

        Mapeo inteligente del estatus:
            Retardo (late)        → Retardo Justificado (late_justified)
            Inasistencia (absent) → Falta Justificada  (absent_justified)
        Los registros ya justificados se re-procesan (permite editar el aval/motivo).
        Cualquier otro estatus se omite. Guarda motivo, número de aval, aprobador
        y fecha; deja constancia en el historial (chatter).

        Returns: {'justified': n, 'skipped': n}
        """
        self._ensure_coordinator(_('justificar registros'))

        reason = (reason or '').strip()
        aval_number = (aval_number or '').strip()
        if not reason:
            raise UserError(_('El motivo de la justificación es obligatorio.'))
        if not aval_number:
            raise UserError(_('El número de aval es obligatorio.'))
        if not record_ids:
            raise UserError(_('Debe seleccionar al menos un registro para justificar.'))

        status_labels = dict(self._fields['status'].selection)
        records = self.browse(record_ids).exists()
        now = fields.Datetime.now()
        justified, skipped = 0, 0

        for rec in records:
            target = JUSTIFY_TARGET.get(rec.status)
            if not target:
                skipped += 1
                continue
            rec.write({
                'status': target,
                'justification_reason': reason,
                'justification_aval': aval_number,
                'justification_approver_id': self.env.uid,
                'justification_date': now,
            })
            rec.message_post(body=_(
                'Justificado como «%s» por %s. Aval N° %s. Motivo: %s'
            ) % (status_labels.get(target, target), self.env.user.name, aval_number, reason))
            justified += 1

        return {'justified': justified, 'skipped': skipped}

    @api.model
    def action_revert_justification(self, record_ids):
        """Revierte la justificación de los registros seleccionados (Coordinación):
            Retardo Justificado → Retardo
            Falta Justificada   → Inasistencia
        Limpia el aval, motivo, aprobador y fecha. Deja constancia en el historial.

        Returns: {'reverted': n, 'skipped': n}
        """
        self._ensure_coordinator(_('revertir justificaciones'))

        if not record_ids:
            raise UserError(_('Debe seleccionar al menos un registro para revertir.'))

        status_labels = dict(self._fields['status'].selection)
        records = self.browse(record_ids).exists()
        reverted, skipped = 0, 0

        for rec in records:
            target = JUSTIFY_REVERT.get(rec.status)
            if not target:
                skipped += 1
                continue
            prev_aval = rec.justification_aval or '—'
            rec.write({
                'status': target,
                'justification_reason': False,
                'justification_aval': False,
                'justification_approver_id': False,
                'justification_date': False,
            })
            rec.message_post(body=_(
                'Justificación revertida por %s (aval previo: %s). '
                'Estatus restablecido a «%s».'
            ) % (self.env.user.name, prev_aval, status_labels.get(target, target)))
            reverted += 1

        return {'reverted': reverted, 'skipped': skipped}

    # ─────────────────────────────────────────────
    # Registro por carnet (cédula) — cámara fija
    # ─────────────────────────────────────────────
    @api.model
    def action_log_attendance_by_cedula(self, cedula, latitude=0, longitude=0):
        if not self.get_method_config()['carnet']:
            return self._method_disabled_response(_('carnet'))

        # Normalizar la cédula recibida: solo dígitos
        import re as _re
        cedula_digits = _re.sub(r'[^0-9]', '', cedula.strip())
        if not cedula_digits or len(cedula_digits) < 6:
            return {'status': 'invalid', 'message': _('Cédula inválida en el QR del carnet: %s') % cedula}

        # Búsqueda optimizada: SQL con REGEXP_REPLACE en PostgreSQL
        # — O(1) vs O(n) Python loop. Normaliza el VAT en la BD y compara.
        self.env.cr.execute(
            """SELECT id FROM res_partner
               WHERE REGEXP_REPLACE(COALESCE(vat, ''), '[^0-9]', '', 'g') = %s
               LIMIT 1""",
            [cedula_digits]
        )
        row = self.env.cr.fetchone()
        if not row:
            return {
                'status': 'invalid',
                'message': _('La cédula %s no está registrada en el sistema. '
                             'Verifique que el docente exista en Gestión de Usuarios.') % cedula,
            }
        partner = self.env['res.partner'].browse(row[0])

        teacher = self.env['res.users'].search([('partner_id', '=', partner.id)], limit=1)
        if not teacher:
            return {
                'status': 'invalid',
                'message': _('La cédula %s existe en el sistema pero no tiene usuario de acceso activo. '
                             'El coordinador debe crear el usuario en Gestión de Usuarios.') % cedula,
            }

        local_time = fields.Datetime.context_timestamp(self, fields.Datetime.now())
        current_day = str(local_time.weekday())
        current_hour = local_time.hour + (local_time.minute / 60.0)

        schedule = self.env['attendance.schedule'].search([
            ('teacher_id', '=', teacher.id),
            ('day_of_week', '=', current_day),
            ('start_hour', '<=', current_hour),
            ('end_hour', '>=', current_hour),
        ], limit=1)

        classroom = False
        if schedule:
            classroom = schedule.classroom_id
        else:
            classrooms = self.env['attendance.classroom'].search([])
            best_distance = float('inf')
            for cr in classrooms:
                if latitude and longitude and cr.latitude and cr.longitude:
                    R = 6371e3
                    phi1 = math.radians(latitude)
                    phi2 = math.radians(cr.latitude)
                    delta_phi = math.radians(cr.latitude - latitude)
                    delta_lambda = math.radians(cr.longitude - longitude)
                    a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
                    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                    dist = R * c
                    if dist < best_distance:
                        best_distance = dist
                        classroom = cr

        if not classroom:
            return {'status': 'invalid', 'message': _('No se pudo determinar el aula. Acérquese a un aula registrada.')}

        active_log = self.search([
            ('teacher_id', '=', teacher.id),
            ('classroom_id', '=', classroom.id),
            ('check_out', '=', False),
            ('status', '!=', 'absent'),
            ('check_in', '>', fields.Datetime.now() - datetime.timedelta(hours=12))
        ], limit=1)

        server_now = fields.Datetime.now()

        if active_log:
            active_log.write({'check_out': server_now})
            return {
                'status': 'checkout',
                'message': _('Salida registrada para %s. Duracion: %.1f horas.') % (teacher.name, active_log.duration),
                'server_time': fields.Datetime.to_string(server_now),
            }

        vals = {
            'teacher_id': teacher.id,
            'classroom_id': classroom.id,
            'check_in': server_now,          # EXPLÍCITO: hora del servidor
            'latitude': latitude,
            'longitude': longitude,
            'method': 'carnet',
        }
        log = self.create(vals)
        return {
            'status': log.status,
            'message': _('Entrada registrada para %s en %s.') % (teacher.name, classroom.name),
            'server_time': fields.Datetime.to_string(server_now),
        }

    # ─────────────────────────────────────────────
    # Registro por PIN (modo kiosko)
    # ─────────────────────────────────────────────
    @api.model
    def action_log_attendance_by_pin(self, pin, classroom_id):
        if not self.get_method_config()['kiosk']:
            return self._method_disabled_response(_('kiosko'))

        if not pin or len(str(pin)) != 4:
            return {'status': 'invalid', 'message': _('PIN inválido.')}

        teacher = self.env['res.users'].sudo().search([
            ('attendance_pin', '=', str(pin)),
            ('active', '=', True),
        ], limit=1)
        if not teacher:
            return {'status': 'invalid', 'message': _('PIN no reconocido.')}

        classroom = self.env['attendance.classroom'].browse(int(classroom_id))
        if not classroom.exists():
            return {'status': 'invalid', 'message': _('Aula no encontrada.')}

        active_log = self.search([
            ('teacher_id', '=', teacher.id),
            ('classroom_id', '=', classroom.id),
            ('check_out', '=', False),
            ('status', '!=', 'absent'),
            ('check_in', '>', fields.Datetime.now() - datetime.timedelta(hours=12))
        ], limit=1)

        server_now = fields.Datetime.now()

        if active_log:
            active_log.write({'check_out': server_now})
            return {
                'status': 'checkout',
                'teacher_name': teacher.name,
                'message': _('Salida registrada para %s.') % teacher.name,
                'server_time': fields.Datetime.to_string(server_now),
            }

        log = self.create({
            'teacher_id': teacher.id,
            'classroom_id': classroom.id,
            'check_in': server_now,          # EXPLÍCITO: hora del servidor
            'latitude': 0,
            'longitude': 0,
            'method': 'kiosk',
        })
        return {
            'status': log.status,
            'teacher_name': teacher.name,
            'message': _('Entrada registrada para %s en %s.') % (teacher.name, classroom.name),
            'server_time': fields.Datetime.to_string(server_now),
        }

    def write(self, vals):
        """Protege la justificación de registros de contingencia:
        una vez establecida, no puede modificarse (campo sellado e inalterable).
        Solo se permite la escritura desde la propia lógica de contingencia
        (indicado por el contexto 'contingency_seal_bypass').
        """
        if 'justification' in vals and not self.env.context.get('contingency_seal_bypass'):
            locked = self.filtered(
                lambda l: l.method == 'manual' and bool(l.justification)
            )
            if locked:
                names = ', '.join(locked.mapped('teacher_id.name'))
                raise UserError(
                    _('La justificación de contingencia de %s ya fue sellada y no '
                      'puede modificarse. Es un registro inalterable de auditoría.') % names
                )
        return super().write(vals)

    @api.model
    def generate_absence_records(self):
        """Cron cada 30 min: marca Inasistencia a docentes que no registraron
        en clases que ya terminaron (con 30 min de gracia para tardanzas extremas)."""
        now_utc = fields.Datetime.now()
        now_local = fields.Datetime.context_timestamp(self, now_utc)
        current_day  = str(now_local.weekday())
        current_hour = now_local.hour + (now_local.minute / 60.0)
        today        = now_local.date()
        GRACE_H      = 0.5   # 30 minutos de gracia tras fin de clase

        # Calendario institucional: en feriados / excepciones no laborables
        # NO se generan inasistencias automáticas.
        if self.env['attendance.calendar.day'].sudo().is_non_working(today):
            return

        # Buscar clases que terminaron hace más de GRACE_H y menos de 24h
        schedules = self.env['attendance.schedule'].sudo().search([
            ('day_of_week', '=', current_day),
        ]).filtered(lambda s: s.end_hour <= current_hour - GRACE_H)

        if not schedules:
            return

        user_tz_name = self.env.user.tz or 'America/Caracas'
        try:
            local_tz = pytz.timezone(user_tz_name)
        except Exception:
            local_tz = pytz.timezone('America/Caracas')

        for sched in schedules:
            teacher   = sched.teacher_id
            classroom = sched.classroom_id

            # ¿El docente ya tiene algún registro real hoy en este aula?
            today_start_utc = local_tz.localize(
                datetime.datetime.combine(today, datetime.time(0, 0))
            ).astimezone(pytz.utc).replace(tzinfo=None)

            real_log = self.sudo().search([
                ('teacher_id',   '=', teacher.id),
                ('classroom_id', '=', classroom.id),
                ('check_in',     '>=', today_start_utc),
                ('status',       '!=', 'absent'),
            ], limit=1)

            if real_log:
                continue  # Ya registró → no generar ausencia

            # ¿Ya existe una ausencia generada para este bloque exacto?
            class_start_naive = datetime.datetime.combine(
                today, datetime.time(int(sched.start_hour),
                                     int(round((sched.start_hour % 1) * 60)))
            )
            class_start_utc = local_tz.localize(class_start_naive).astimezone(
                pytz.utc).replace(tzinfo=None)

            existing_absence = self.sudo().search([
                ('teacher_id',   '=', teacher.id),
                ('classroom_id', '=', classroom.id),
                ('check_in',     '=', fields.Datetime.to_string(class_start_utc)),
                ('status',       '=', 'absent'),
            ], limit=1)

            if not existing_absence:
                start_h = int(sched.start_hour)
                start_m = int(round((sched.start_hour % 1) * 60))
                end_h   = int(sched.end_hour)
                end_m   = int(round((sched.end_hour % 1) * 60))
                self.sudo().create({
                    'teacher_id':   teacher.id,
                    'classroom_id': classroom.id,
                    'subject_id':   sched.subject_id.id,
                    'check_in':     class_start_utc,
                    'status':       'absent',
                    'justification': _(
                        'Inasistencia registrada automáticamente. '
                        'Bloque: %s, %02d:%02d–%02d:%02d. '
                        'El docente no registró asistencia.'
                    ) % (sched.subject_id.name, start_h, start_m, end_h, end_m),
                })

    def action_validate_manually(self):
        self.write({'status': 'manual'})
        self.message_post(body=_("Attendance validated manually by %s") % self.env.user.name)

    # ─────────────────────────────────────────────
    # Registro de contingencia (coordinadores/admins)
    # ─────────────────────────────────────────────
    @api.model
    def action_create_contingency_log(self, teacher_id, classroom_id,
                                      entry_type, entry_datetime_str, justification):
        """Crea o cierra un registro de asistencia manual por contingencia.

        Args:
            teacher_id (int): ID del docente.
            classroom_id (int): ID del aula.
            entry_type (str): 'checkin' o 'checkout'.
            entry_datetime_str (str): Fecha/hora en formato 'YYYY-MM-DDTHH:MM'.
            justification (str): Razón obligatoria del registro manual.
        """
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo los coordinadores pueden registrar asistencia por contingencia.'))

        justification = (justification or '').strip()
        if not justification:
            raise UserError(_('La justificación es obligatoria para el registro manual de contingencia.'))
        if len(justification) < 20:
            raise UserError(
                _('La justificación debe tener al menos 20 caracteres para garantizar '
                  'que sea descriptiva y útil para la auditoría (actual: %d caracteres).') % len(justification)
            )

        from datetime import datetime as dt
        try:
            naive_local = dt.strptime(entry_datetime_str, '%Y-%m-%dT%H:%M')
        except ValueError:
            raise UserError(_('Formato de fecha/hora inválido. Use YYYY-MM-DDTHH:MM.'))

        # Convertir hora local del coordinador a UTC para almacenamiento correcto.
        # Odoo almacena SIEMPRE en UTC; si no convertimos, una hora 14:30 Venezuela
        # (UTC-4) se guardaría como 14:30 UTC = 10:30 hora local → error de 4h.
        user_tz_name = self.env.user.tz or 'America/Caracas'
        try:
            local_tz = pytz.timezone(user_tz_name)
            entry_dt = local_tz.localize(naive_local).astimezone(pytz.utc).replace(tzinfo=None)
        except Exception:
            entry_dt = naive_local  # fallback conservador

        teacher = self.env['res.users'].browse(int(teacher_id))
        classroom = self.env['attendance.classroom'].browse(int(classroom_id))
        if not teacher.exists() or not classroom.exists():
            raise UserError(_('Docente o aula no encontrados.'))

        if entry_type == 'checkout':
            active_log = self.search([
                ('teacher_id', '=', teacher.id),
                ('classroom_id', '=', classroom.id),
                ('check_out', '=', False),
            ('status', '!=', 'absent'),
            ], order='check_in desc', limit=1)
            if not active_log:
                raise UserError(
                    _('No existe una entrada abierta para %s en %s. '
                      'Registre primero la entrada.') % (teacher.name, classroom.name)
                )
            # Si el log ya tiene justificación (creado también por contingencia),
            # se usa el bypass del sello para no sobreescribirla.
            update_vals = {'check_out': entry_dt, 'status': 'manual'}
            if not active_log.justification:
                update_vals['justification'] = justification
            active_log.with_context(contingency_seal_bypass=True).write(update_vals)
            active_log.message_post(
                body=_('Salida por contingencia manual por %s. Motivo: %s') % (
                    self.env.user.name, justification)
            )
            return {
                'entry_type': 'checkout',
                'teacher_name': teacher.name,
                'message': _('Salida registrada para %s.') % teacher.name,
            }
        else:
            log = self.create({
                'teacher_id': teacher.id,
                'classroom_id': classroom.id,
                'check_in': entry_dt,
                'justification': justification.strip(),
                'method': 'manual',
                'status': 'manual',
            })
            log.message_post(
                body=_('Entrada registrada por contingencia manual por %s.') % self.env.user.name
            )
            return {
                'entry_type': 'checkin',
                'teacher_name': teacher.name,
                'message': _('Entrada registrada para %s en %s.') % (teacher.name, classroom.name),
            }

    @api.model
    def get_recent_contingency_logs(self, limit=30):
        """Retorna los últimos registros manuales para el panel de auditoría."""
        logs = self.search([('method', '=', 'manual')],
                           order='check_in desc', limit=limit)
        return logs.read([
            'teacher_id', 'classroom_id', 'check_in', 'check_out',
            'duration', 'justification', 'status',
        ])
