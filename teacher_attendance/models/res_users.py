# -*- coding: utf-8 -*-
from odoo import models, fields

class ResUsers(models.Model):
    _inherit = 'res.users'

    attendance_pin = fields.Char(string='Attendance PIN', size=4, help="4-digit PIN for kiosk mode.")
