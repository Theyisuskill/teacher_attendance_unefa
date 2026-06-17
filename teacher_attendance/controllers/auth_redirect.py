# -*- coding: utf-8 -*-
import re
from odoo.http import request
from odoo.addons.web.controllers.home import Home

# Ruta del web client hacia el dashboard del escáner QR (acción cliente)
SCANNER_URL = '/odoo/action-teacher_attendance.action_attendance_dashboard'

# Coincide con la home genérica de Odoo: /odoo o /odoo?cualquier-param
# No coincide con deep links como /odoo/accion-especifica o /odoo/modulo/id
_HOME_GENERICA = re.compile(r'^/odoo(\?.*)?$')


class AttendanceLoginRedirect(Home):

    def _login_redirect(self, uid, redirect=None):
        """Tras iniciar sesión, llevar al usuario al dashboard del escáner QR.
        Respeta deep links (redirect con ruta específica) pero ignora el
        redirect genérico /odoo o /odoo?db=xxx que Odoo inserta
        automáticamente cuando el navegador accede a la raíz."""
        es_home_generica = not redirect or bool(_HOME_GENERICA.match(redirect))
        if es_home_generica:
            user = request.env['res.users'].sudo().browse(uid)
            if user.exists() and (user._has_attendance_access() or user._is_system()):
                return SCANNER_URL
        return super()._login_redirect(uid, redirect=redirect)
