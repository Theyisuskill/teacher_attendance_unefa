# -*- coding: utf-8 -*-
import math
import datetime
import pytz
from odoo import models, fields, api, _
from odoo.exceptions import AccessError

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
    is_substitution = fields.Boolean(string='Is Substitution', default=False)

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
    ], string='Estatus', compute='_compute_status', store=True, readonly=False, tracking=True)

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

    @api.depends('distance', 'classroom_id', 'check_in', 'teacher_id')
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
            # Regla 0: No recalcular registros manuales o de ausencia
            if log.status in ('manual', 'absent'):
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
    def action_log_attendance(self, secret_key, latitude, longitude, signature=None, device_id=None):
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
        if signature:
            if ',' in signature: signature = signature.split(',')[1]
            vals['signature'] = signature
        log = self.create(vals)
        return {
            'status': log.status,
            'message': _('Check-in successful!') if log.status == 'valid' else _('Check-in outside of parameters.'),
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
