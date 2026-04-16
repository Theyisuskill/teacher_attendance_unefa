# -*- coding: utf-8 -*-
import base64
import io
import qrcode
import uuid
from odoo import models, fields, api

class AttendanceClassroom(models.Model):
    _name = 'attendance.classroom'
    _description = 'Classroom'

    name = fields.Char(string='Classroom Name', required=True)
    code = fields.Char(string='Code', required=True)
    qr_code = fields.Binary(string='QR Code', compute='_compute_qr_code', store=True)
    latitude = fields.Float(string='Latitude', digits=(16, 5))
    longitude = fields.Float(string='Longitude', digits=(16, 5))
    radius = fields.Integer(string='Radius (m)', default=20)
    secret_key = fields.Char(string='Secret Key', readonly=True, default=lambda self: str(uuid.uuid4()))
    
    check_schedule = fields.Boolean(string='Validate Schedule', default=False)
    tolerance_margin = fields.Integer(string='Tolerance (min)', default=15, help="Minutes allowed after the start hour.")
    schedule_ids = fields.One2many('attendance.schedule', 'classroom_id', string='Schedules')

    _sql_constraints = [
        ('code_unique', 'unique(code)', 'The classroom code must be unique!'),
    ]

    @api.depends('secret_key')
    def _compute_qr_code(self):
        for record in self:
            if record.secret_key:
                qr = qrcode.QRCode(
                    version=1,
                    error_correction=qrcode.constants.ERROR_CORRECT_L,
                    box_size=10,
                    border=4,
                )
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

    classroom_id = fields.Many2one('attendance.classroom', string='Classroom', ondelete='cascade')
    day_of_week = fields.Selection([
        ('0', 'Monday'),
        ('1', 'Tuesday'),
        ('2', 'Wednesday'),
        ('3', 'Thursday'),
        ('4', 'Friday'),
        ('5', 'Saturday'),
        ('6', 'Sunday'),
    ], string='Day of Week', required=True)
    start_hour = fields.Float(string='Start Hour', required=True)
    end_hour = fields.Float(string='End Hour', required=True)

    @api.constrains('start_hour', 'end_hour')
    def _check_hours(self):
        for record in self:
            if record.start_hour >= record.end_hour:
                raise models.ValidationError("Start hour must be before end hour.")
