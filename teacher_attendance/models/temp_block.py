# -*- coding: utf-8 -*-
import base64
import io
import uuid
import datetime

import qrcode
import pytz
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError, AccessError, UserError

from .attendance_log import ACTIVITY_TYPES

# Prefijo del token para que el scanner distinga un QR de bloque temporal
# de un QR de aula (uuid plano) o de un carnet (cédula).
TOKEN_PREFIX = 'TMPB-'

# Márgenes de la ventana de registro
LEAD_MINUTES = 15    # se puede registrar hasta 15 min antes del inicio
GRACE_MINUTES = 30   # y hasta 30 min después del fin


class AttendanceTempBlock(models.Model):
    _name = 'attendance.temp.block'
    _description = 'Bloque de Asistencia Temporal'
    _order = 'date_start desc'

    name = fields.Char(string='Actividad', required=True,
                       help="Nombre de la actividad no rutinaria (p. ej. «Defensa TEG - Juan Pérez»).")
    activity_type = fields.Selection(
        ACTIVITY_TYPES, string='Tipo de Actividad', default='defensa', required=True,
        help="Renglón al que se sumará el tiempo ejecutado de quienes registren en este bloque.")
    subject_id = fields.Many2one('attendance.subject', string='Materia')
    classroom_id = fields.Many2one(
        'attendance.classroom', string='Aula / Lugar', required=True,
        help="Lugar de la actividad. La validación GPS contra su radio es opcional (ver «Exigir GPS»).")
    date_start = fields.Datetime(string='Inicio', required=True)
    date_end = fields.Datetime(string='Fin', required=True)
    require_gps = fields.Boolean(
        string='Exigir ubicación GPS', default=False,
        help="Si se activa, el registro debe estar dentro del radio del aula; de lo contrario, "
             "basta escanear el QR dentro de la ventana de tiempo.")
    note = fields.Text(string='Notas')
    active = fields.Boolean(string='Activo', default=True)

    token = fields.Char(string='Token QR', readonly=True, index=True, copy=False,
                        default=lambda self: self._new_token())
    qr_code = fields.Binary(string='QR', compute='_compute_qr_code', store=True)

    log_ids = fields.One2many('attendance.log', 'temp_block_id', string='Registros')
    registration_count = fields.Integer(string='Registros', compute='_compute_stats')
    total_hours = fields.Float(string='Horas Ejecutadas', compute='_compute_stats')
    state = fields.Selection([
        ('scheduled', 'Programado'),
        ('open',      'En curso'),
        ('expired',   'Finalizado'),
        ('cancelled', 'Cancelado'),
    ], string='Estado', compute='_compute_state')

    # ── Token / QR ──────────────────────────────────────
    @api.model
    def _new_token(self):
        return TOKEN_PREFIX + str(uuid.uuid4())

    @api.depends('token')
    def _compute_qr_code(self):
        for rec in self:
            if rec.token:
                qr = qrcode.QRCode(version=1, box_size=10, border=4)
                qr.add_data(rec.token)
                qr.make(fit=True)
                img = qr.make_image(fill_color="black", back_color="white")
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                rec.qr_code = base64.b64encode(buf.getvalue())
            else:
                rec.qr_code = False

    @api.depends('log_ids', 'log_ids.duration', 'log_ids.status')
    def _compute_stats(self):
        for rec in self:
            rec.registration_count = len(rec.log_ids)
            rec.total_hours = sum(rec.log_ids.mapped('duration'))

    def _compute_state(self):
        now = fields.Datetime.now()
        for rec in self:
            if not rec.active:
                rec.state = 'cancelled'
            elif rec.date_start and now < rec.date_start:
                rec.state = 'scheduled'
            elif rec.date_end and now > rec.date_end:
                rec.state = 'expired'
            else:
                rec.state = 'open'

    @api.constrains('date_start', 'date_end')
    def _check_dates(self):
        for rec in self:
            if rec.date_start and rec.date_end and rec.date_end <= rec.date_start:
                raise ValidationError(_('La hora de fin debe ser posterior a la hora de inicio.'))

    # ── Helpers ─────────────────────────────────────────
    def _check_coordinator(self):
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo la Coordinación puede gestionar bloques temporales.'))

    @api.model
    def _local_to_utc(self, value):
        """Convierte 'YYYY-MM-DDTHH:MM' (hora local del usuario) a datetime UTC naive."""
        if not value:
            return False
        txt = value.replace('T', ' ')
        fmt = '%Y-%m-%d %H:%M:%S' if txt.count(':') == 2 else '%Y-%m-%d %H:%M'
        naive = datetime.datetime.strptime(txt, fmt)
        tz_name = self.env.user.tz or 'America/Caracas'
        try:
            tz = pytz.timezone(tz_name)
            return tz.localize(naive).astimezone(pytz.utc).replace(tzinfo=None)
        except Exception:
            return naive

    # ── API para la interfaz OWL ────────────────────────
    @api.model
    def create_from_ui(self, vals):
        self._check_coordinator()
        vals = dict(vals)
        for f in ('date_start', 'date_end'):
            if vals.get(f):
                vals[f] = self._local_to_utc(vals[f])
        block = self.create(vals)
        return block.id

    def write_from_ui(self, vals):
        self._check_coordinator()
        vals = dict(vals)
        for f in ('date_start', 'date_end'):
            if vals.get(f):
                vals[f] = self._local_to_utc(vals[f])
        self.write(vals)
        return True

    def action_regenerate_token(self):
        """Invalida el QR anterior generando un token nuevo."""
        self._check_coordinator()
        for rec in self:
            rec.token = self._new_token()
        return True

    @api.model
    def get_block_card_data(self, block_id):
        """Datos para imprimir la tarjeta QR del bloque temporal."""
        block = self.browse(int(block_id))
        if not block.exists():
            return {}

        def fmt(dt):
            if not dt:
                return ''
            local = fields.Datetime.context_timestamp(self, dt)
            return local.strftime('%d/%m/%Y %H:%M')

        type_labels = dict(ACTIVITY_TYPES)
        return {
            'name': block.name,
            'activity_type': type_labels.get(block.activity_type, ''),
            'classroom_name': block.classroom_id.name,
            'subject_name': block.subject_id.name or '',
            'date_start': fmt(block.date_start),
            'date_end': fmt(block.date_end),
            'require_gps': block.require_gps,
            'qr_base64': block.qr_code.decode() if block.qr_code else '',
        }
