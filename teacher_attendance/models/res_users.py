# -*- coding: utf-8 -*-
import re
import logging
from datetime import timedelta

import odoo
from odoo import models, fields, api, SUPERUSER_ID
from odoo.exceptions import AccessDenied, ValidationError, UserError

_logger = logging.getLogger(__name__)

# Intentos fallidos antes de bloquear la cuenta
MAX_FAILED_ATTEMPTS = 3
# Duración del bloqueo temporal (minutos)
LOCKOUT_MINUTES = 30


class ResUsers(models.Model):
    _inherit = 'res.users'

    attendance_pin = fields.Char(string='Attendance PIN', size=4)

    # ── Información académica del docente ──────────────
    teacher_category = fields.Selection([
        ('instructor',  'Instructor'),
        ('asistente',   'Asistente'),
        ('agregado',    'Agregado'),
        ('asociado',    'Asociado'),
        ('titular',     'Titular'),
    ], string='Categoría Docente',
       help="Escalafón académico según el reglamento UNEFA.")

    teacher_dedication = fields.Selection([
        ('completo',  'Tiempo Completo'),
        ('medio',     'Medio Tiempo'),
        ('variable',  'Tiempo Variable'),
    ], string='Dedicación',
       help="Tipo de dedicación a la institución.")

    # ── Bloqueo por intentos fallidos ──────────────────
    failed_login_attempts = fields.Integer(
        string='Intentos Fallidos',
        default=0,
        help="Contador de intentos consecutivos fallidos de inicio de sesión.",
    )
    lockout_until = fields.Datetime(
        string='Bloqueado Hasta',
        help="Si está definido y en el futuro, el usuario no puede iniciar sesión.",
    )

    attendance_device_id = fields.Char(
        string='Dispositivo Vinculado',
        help="Identificador del dispositivo registrado para marcar asistencia. "
             "Se vincula automáticamente en el primer registro cuando la validación "
             "de dispositivo está activa. El coordinador puede liberarlo.",
    )

    attendance_role = fields.Selection(
        [('none', 'Sin rol'), ('teacher', 'Docente'),
         ('coordinator', 'Coordinador'), ('admin', 'Administrador')],
        string='Rol de Asistencia',
        compute='_compute_attendance_role',
        inverse='_inverse_attendance_role',
        store=True,
    )

    # ─────────────────────────────────────────────
    # Unicidad de cédula
    # ─────────────────────────────────────────────

    @staticmethod
    def _normalize_vat(vat):
        """Normaliza la cédula/RIF eliminando prefijo, guiones, puntos y espacios
        para comparar de forma homogénea (V-12.345.678 == 12345678)."""
        if not vat:
            return ''
        # Eliminar espacios, puntos, guiones y prefijo de tipo (V, E, J, G, C)
        return re.sub(r'[^0-9]', '', vat)

    @api.constrains('vat')
    def _check_vat_unique(self):
        """Impide registrar dos usuarios con la misma cédula."""
        for user in self:
            if not user.vat:
                continue
            norm = self._normalize_vat(user.vat)
            if not norm:
                continue
            # Buscar otros usuarios activos (o inactivos) con la misma cédula
            others = self.with_context(active_test=False).search([('id', '!=', user.id)])
            for other in others:
                if self._normalize_vat(other.vat) == norm:
                    raise ValidationError(
                        f'La cédula "{user.vat}" ya está registrada para el usuario '
                        f'"{other.name}". Cada docente debe tener una cédula única.'
                    )

    @api.model
    def attendance_check_vat(self, vat, exclude_id=False):
        """Verifica si una cédula ya está registrada.
        Retorna dict  {available: True}  o  {available: False, owner: 'Nombre'}.
        Llamado desde el UserManager OWL antes de guardar."""
        if not vat:
            return {'available': True}
        norm = self._normalize_vat(vat)
        if not norm:
            return {'available': True}
        users = self.with_context(active_test=False).search([])
        for u in users:
            if exclude_id and u.id == exclude_id:
                continue
            if self._normalize_vat(u.vat) == norm:
                return {'available': False, 'owner': u.name}
        return {'available': True}

    # ── Login con bloqueo por cuenta ───────────────────

    def _login(self, credential, user_agent_env):
        """Override: bloquea la cuenta tras MAX_FAILED_ATTEMPTS intentos consecutivos."""
        login = credential.get('login', '')
        user = self.sudo().search([('login', '=', login)], limit=1)

        if user:
            now = fields.Datetime.now()
            if user.lockout_until:
                if user.lockout_until > now:
                    remaining = int((user.lockout_until - now).total_seconds() // 60) + 1
                    raise AccessDenied(
                        f'Cuenta bloqueada temporalmente ({remaining} min restantes). '
                        f'Contacte al Coordinador para desbloquearla.'
                    )
                # Bloqueo expirado — limpiar con cursor propio
                self._update_login_counter(user.id, reset=True)

        try:
            result = super()._login(credential, user_agent_env)
            # Éxito: resetear contador
            if user:
                self._update_login_counter(user.id, reset=True)
            return result
        except AccessDenied:
            if user:
                self._update_login_counter(user.id, failed=True)
            raise

    def _update_login_counter(self, user_id, *, reset=False, failed=False):
        """Actualiza el contador de fallos usando un cursor independiente
        para que persista aunque la transacción principal haga rollback."""
        try:
            with odoo.registry(self.env.cr.dbname).cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                user = env['res.users'].browse(user_id)
                if reset:
                    user.write({'failed_login_attempts': 0, 'lockout_until': False})
                elif failed:
                    new_count = (user.failed_login_attempts or 0) + 1
                    vals = {'failed_login_attempts': new_count}
                    if new_count >= MAX_FAILED_ATTEMPTS:
                        lockout_until = fields.Datetime.now() + timedelta(minutes=LOCKOUT_MINUTES)
                        vals['lockout_until'] = lockout_until
                        _logger.warning(
                            "Account locked for user %s (%s) after %d failed attempts. "
                            "Locked until %s.",
                            user.login, user.name, new_count, lockout_until
                        )
                    user.write(vals)
                cr.commit()
        except Exception as exc:
            _logger.warning("Could not update login failure counter for user %d: %s", user_id, exc)

    @api.model
    def attendance_unlock_account(self, user_id):
        """Desbloquea manualmente la cuenta de un usuario. Solo coordinadores/admins."""
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise UserError('Solo los coordinadores pueden desbloquear cuentas.')
        user = self.browse(int(user_id))
        if not user.exists():
            raise UserError('Usuario no encontrado.')
        user.write({'failed_login_attempts': 0, 'lockout_until': False})
        _logger.info(
            "Account unlocked for user %s (%s) by %s.",
            user.login, user.name, self.env.user.name
        )
        return True

    @api.depends('group_ids')
    def _compute_attendance_role(self):
        admin_grp = self.env.ref('teacher_attendance.group_admin', raise_if_not_found=False)
        coord_grp = self.env.ref('teacher_attendance.group_coordinator', raise_if_not_found=False)
        teacher_grp = self.env.ref('teacher_attendance.group_teacher', raise_if_not_found=False)
        for u in self:
            if admin_grp and admin_grp in u.group_ids:
                u.attendance_role = 'admin'
            elif coord_grp and coord_grp in u.group_ids:
                u.attendance_role = 'coordinator'
            elif teacher_grp and teacher_grp in u.group_ids:
                u.attendance_role = 'teacher'
            else:
                u.attendance_role = 'none'

    def _inverse_attendance_role(self):
        admin_grp = self.env.ref('teacher_attendance.group_admin')
        coord_grp = self.env.ref('teacher_attendance.group_coordinator')
        teacher_grp = self.env.ref('teacher_attendance.group_teacher')
        odoo_admin_grp = self.env.ref('base.group_system')
        action = self.env.ref('teacher_attendance.action_attendance_dashboard', raise_if_not_found=False)
        all_grps = [admin_grp.id, coord_grp.id, teacher_grp.id]
        for u in self:
            current = [g.id for g in u.group_ids if g.id in all_grps]
            if u.attendance_role == 'admin':
                # group_admin ya implica group_coordinator y base.group_system vía implied_ids
                u.group_ids = [(3, g) for g in current] + [(4, admin_grp.id)]
                if action:
                    u.action_id = action.id
            elif u.attendance_role == 'coordinator':
                u.group_ids = [(3, g) for g in current] + [(4, coord_grp.id)]
                if action:
                    u.action_id = action.id
            elif u.attendance_role == 'teacher':
                u.group_ids = [(3, g) for g in current] + [(4, teacher_grp.id)]
                if action:
                    u.action_id = action.id
            else:
                u.group_ids = [(3, g) for g in current]
                if action and u.action_id == action:
                    u.action_id = False
