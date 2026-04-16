# -*- coding: utf-8 -*-
from odoo import models, fields, api

class AttendanceSubstitution(models.Model):
    _name = 'attendance.substitution'
    _description = 'Teacher Substitution'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'date desc'

    classroom_id = fields.Many2one('attendance.classroom', string='Classroom', required=True, tracking=True)
    subject_id = fields.Many2one('attendance.subject', string='Subject', required=True, tracking=True)
    original_teacher_id = fields.Many2one('res.users', string='Original Teacher', required=True, tracking=True)
    substitute_teacher_id = fields.Many2one('res.users', string='Substitute Teacher', required=True, tracking=True)
    date = fields.Date(string='Substitution Date', required=True, default=fields.Date.today, tracking=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('active', 'Active'),
        ('done', 'Done'),
        ('cancelled', 'Cancelled'),
    ], string='Status', default='draft', tracking=True)

    def action_activate(self):
        self.write({'state': 'active'})

    def action_done(self):
        self.write({'state': 'done'})
