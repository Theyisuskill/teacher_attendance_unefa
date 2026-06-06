# -*- coding: utf-8 -*-
from odoo import models, fields, api


class ResUsers(models.Model):
    _inherit = 'res.users'

    attendance_pin = fields.Char(string='Attendance PIN', size=4)

    attendance_role = fields.Selection(
        [('none', 'Sin rol'), ('employee', 'Empleado'), ('teacher', 'Docente'), ('coordinator', 'Coordinador')],
        string='Rol de Asistencia',
        compute='_compute_attendance_role',
        inverse='_inverse_attendance_role',
        store=True,
    )

    @api.depends('group_ids')
    def _compute_attendance_role(self):
        teacher_grp = self.env.ref('teacher_attendance.group_teacher', raise_if_not_found=False)
        coord_grp = self.env.ref('teacher_attendance.group_coordinator', raise_if_not_found=False)
        emp_grp = self.env.ref('teacher_attendance.group_employee', raise_if_not_found=False)
        for u in self:
            if coord_grp and coord_grp in u.group_ids:
                u.attendance_role = 'coordinator'
            elif teacher_grp and teacher_grp in u.group_ids:
                u.attendance_role = 'teacher'
            elif emp_grp and emp_grp in u.group_ids:
                u.attendance_role = 'employee'
            else:
                u.attendance_role = 'none'

    def _inverse_attendance_role(self):
        teacher_grp = self.env.ref('teacher_attendance.group_teacher')
        coord_grp = self.env.ref('teacher_attendance.group_coordinator')
        emp_grp = self.env.ref('teacher_attendance.group_employee')
        action = self.env.ref('teacher_attendance.action_attendance_dashboard', raise_if_not_found=False)
        all_grps = [teacher_grp.id, coord_grp.id, emp_grp.id]
        for u in self:
            current = [g.id for g in u.group_ids if g.id in all_grps]
            if u.attendance_role == 'coordinator':
                u.group_ids = [(3, g) for g in current] + [(4, coord_grp.id)]
                if action:
                    u.action_id = action.id
            elif u.attendance_role == 'teacher':
                u.group_ids = [(3, g) for g in current] + [(4, teacher_grp.id)]
                if action:
                    u.action_id = action.id
            elif u.attendance_role == 'employee':
                u.group_ids = [(3, g) for g in current] + [(4, emp_grp.id)]
                if action:
                    u.action_id = action.id
            else:
                u.group_ids = [(3, g) for g in current]
                if action and u.action_id == action:
                    u.action_id = False
