# -*- coding: utf-8 -*-
from odoo.http import request
from odoo.addons.web.controllers.home import Home

# Ruta del web client hacia el dashboard del escáner QR (acción cliente)
SCANNER_URL = '/odoo/action-teacher_attendance.action_attendance_dashboard'


class AttendanceLoginRedirect(Home):

    def _login_redirect(self, uid, redirect=None):
        """Tras iniciar sesión desde el login de Odoo, llevar al usuario
        directamente al dashboard del escáner QR (salvo que ya venga un
        destino explícito, p. ej. un enlace profundo)."""
        if not redirect:
            user = request.env['res.users'].sudo().browse(uid)
            if user.exists() and (user._has_attendance_access() or user._is_system()):
                return SCANNER_URL
        return super()._login_redirect(uid, redirect=redirect)
