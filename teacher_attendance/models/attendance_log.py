# -*- coding: utf-8 -*-
import math
import datetime
from odoo import models, fields, api, _

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
    
    status = fields.Selection([
        ('valid', 'Valid'),
        ('manual', 'Manually Validated'),
        ('outside', 'Outside'),
        ('late', 'Out of Schedule'),
        ('invalid', 'Invalid'),
    ], string='Status', compute='_compute_status', store=True, readonly=False, tracking=True)

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
        for log in self:
            if log.status == 'manual': continue
            if log.distance > log.classroom_id.radius:
                log.status = 'outside'
                continue
            
            # Find current schedule/subject
            local_time = fields.Datetime.context_timestamp(log, log.check_in)
            current_day = str(local_time.weekday())
            current_hour = local_time.hour + (local_time.minute / 60.0)
            tolerance = log.classroom_id.tolerance_margin / 60.0
            
            # Check for authorizad substitution first
            sub = self.env['attendance.substitution'].search([
                ('classroom_id', '=', log.classroom_id.id),
                ('substitute_teacher_id', '=', log.teacher_id.id),
                ('date', '=', local_time.date()),
                ('state', '=', 'active')
            ], limit=1)
            
            if sub:
                log.subject_id = sub.subject_id
                log.is_substitution = True
                log.status = 'valid'
                continue

            # Regular schedule check
            schedules = log.classroom_id.schedule_ids.filtered(
                lambda s: s.day_of_week == current_day and 
                s.start_hour <= current_hour <= (s.end_hour + tolerance)
            )
            
            if log.classroom_id.check_schedule:
                valid_schedule = schedules.filtered(lambda s: s.teacher_id == log.teacher_id)
                if not valid_schedule:
                    log.status = 'late'
                    continue
                log.subject_id = valid_schedule[0].subject_id
            
            log.status = 'valid'

    @api.model
    def action_log_attendance(self, secret_key, latitude, longitude, signature=None):
        classroom = self.env['attendance.classroom'].search([('secret_key', '=', secret_key)], limit=1)
        if not classroom:
            return {'status': 'invalid', 'message': _('Invalid QR Code.')}
        
        active_log = self.search([
            ('teacher_id', '=', self.env.uid),
            ('classroom_id', '=', classroom.id),
            ('check_out', '=', False),
            ('check_in', '>', fields.Datetime.now() - datetime.timedelta(hours=12))
        ], limit=1)

        if active_log:
            active_log.write({'check_out': fields.Datetime.now()})
            return {'status': 'valid', 'message': _('Check-out successful!')}

        vals = {'teacher_id': self.env.uid, 'classroom_id': classroom.id, 'latitude': latitude, 'longitude': longitude}
        if signature:
            if ',' in signature: signature = signature.split(',')[1]
            vals['signature'] = signature
        log = self.create(vals)
        return {'status': log.status, 'message': _('Check-in successful!') if log.status == 'valid' else _('Check-in outside of parameters.')}

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

    def action_validate_manually(self):
        self.write({'status': 'manual'})
        self.message_post(body=_("Attendance validated manually by %s") % self.env.user.name)
