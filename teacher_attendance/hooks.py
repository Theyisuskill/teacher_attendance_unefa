# -*- coding: utf-8 -*-
"""Post-migrate hook: configura la acción de inicio (action_id) para todos
los usuarios existentes que tengan un rol de asistencia asignado, de modo
que al iniciar sesión sean redirigidos directamente al dashboard QR."""


def post_migrate(cr, registry):
    from odoo import api, SUPERUSER_ID
    env = api.Environment(cr, SUPERUSER_ID, {})

    action = env.ref(
        'teacher_attendance.action_attendance_dashboard',
        raise_if_not_found=False,
    )
    if not action:
        return

    teacher_grp = env.ref('teacher_attendance.group_teacher', raise_if_not_found=False)
    if not teacher_grp:
        return

    # Todos los usuarios con algún rol de asistencia (teacher/coordinator/admin
    # todos implican group_teacher) que aún no tienen action_id configurado
    users_without_action = env['res.users'].with_context(active_test=False).search([
        ('groups_id', 'in', [teacher_grp.id]),
        ('action_id', '=', False),
    ])

    if users_without_action:
        users_without_action.write({'action_id': action.id})
