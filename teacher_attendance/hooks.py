# -*- coding: utf-8 -*-
"""Post-init hook: configura la acción de inicio (action_id = dashboard QR)
para los usuarios con rol de asistencia que aún no la tengan, de modo que el
botón de inicio del web client también apunte al escáner."""


def post_init_hook(env):
    action = env.ref('teacher_attendance.action_attendance_dashboard', raise_if_not_found=False)
    teacher_grp = env.ref('teacher_attendance.group_teacher', raise_if_not_found=False)
    if not action or not teacher_grp:
        return

    # teacher/coordinator/admin implican todos group_teacher (implied_ids)
    users = env['res.users'].with_context(active_test=False).search([
        ('group_ids', 'in', [teacher_grp.id]),
        ('action_id', '=', False),
    ])
    if users:
        users.write({'action_id': action.id})
