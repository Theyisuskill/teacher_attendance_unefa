# -*- coding: utf-8 -*-
import datetime
from odoo import models, fields, api, _
from odoo.exceptions import AccessError, ValidationError

# Tipos de día del calendario institucional. Ambos son NO laborables:
# en cualquiera de ellos el sistema no genera inasistencias automáticas.
DAY_TYPES = [
    ('holiday',   'Feriado'),
    ('exception', 'Excepción No Laborable'),
]


class AttendanceCalendarDay(models.Model):
    _name = 'attendance.calendar.day'
    _description = 'Día del Calendario Institucional'
    _order = 'date'

    name = fields.Char(string='Descripción', required=True)
    date = fields.Date(string='Fecha', required=True)
    day_type = fields.Selection(DAY_TYPES, string='Tipo', default='holiday', required=True)
    is_recurring = fields.Boolean(
        string='Se repite cada año', default=False,
        help="Si se activa, aplica todos los años en el mismo día y mes "
             "(p. ej. 5 de julio). Editarlo o anularlo afecta a todos los años.")
    note = fields.Text(string='Notas')

    @api.constrains('date', 'is_recurring')
    def _check_unique_date(self):
        for rec in self:
            if not rec.date:
                continue
            if rec.is_recurring:
                others = self.search([('id', '!=', rec.id), ('is_recurring', '=', True)])
                if any(o.date and o.date.month == rec.date.month and o.date.day == rec.date.day
                       for o in others):
                    raise ValidationError(
                        _('Ya existe un día recurrente para el %02d/%02d.')
                        % (rec.date.day, rec.date.month))
            else:
                dup = self.search_count([
                    ('id', '!=', rec.id), ('date', '=', rec.date), ('is_recurring', '=', False)])
                if dup:
                    raise ValidationError(_('Ya existe un día registrado para el %s.') % rec.date)

    # ── API para la interfaz OWL ────────────────────────
    @api.model
    def get_calendar_year(self, year):
        """Días del calendario que aplican al año dado:
        - puntuales cuyo año coincide
        - recurrentes, mapeados a ese año (mismo mes/día)
        """
        year = int(year)
        labels = dict(DAY_TYPES)
        result = []
        for r in self.search([]):
            if not r.date:
                continue
            if r.is_recurring:
                try:
                    d = datetime.date(year, r.date.month, r.date.day)
                except ValueError:
                    continue  # 29 de febrero en año no bisiesto
            else:
                if r.date.year != year:
                    continue
                d = r.date
            result.append({
                'id': r.id,
                'date': d.strftime('%Y-%m-%d'),
                'name': r.name,
                'day_type': r.day_type,
                'day_type_label': labels.get(r.day_type, r.day_type),
                'is_recurring': r.is_recurring,
                'note': r.note or '',
            })
        return result

    @api.model
    def is_non_working(self, check_date):
        """True si la fecha es feriado o excepción no laborable (puntual o recurrente)."""
        if isinstance(check_date, str):
            check_date = fields.Date.to_date(check_date)
        if not check_date:
            return False
        if self.search_count([('date', '=', check_date), ('is_recurring', '=', False)]):
            return True
        for r in self.search([('is_recurring', '=', True)]):
            if r.date and r.date.month == check_date.month and r.date.day == check_date.day:
                return True
        return False

    @api.model
    def duplicate_year(self, source_year, target_year):
        """Copia los días puntuales de un año a otro (los recurrentes ya aplican solos).
        Útil para precargar el calendario del próximo año. Coordinación."""
        if not (self.env.user.has_group('teacher_attendance.group_coordinator')
                or self.env.user.has_group('base.group_system')):
            raise AccessError(_('Solo la Coordinación puede gestionar el calendario institucional.'))
        source_year, target_year = int(source_year), int(target_year)
        src = self.search([('is_recurring', '=', False)]).filtered(
            lambda r: r.date and r.date.year == source_year)
        created = 0
        for r in src:
            try:
                new_date = r.date.replace(year=target_year)
            except ValueError:
                continue
            if self.search_count([('date', '=', new_date), ('is_recurring', '=', False)]):
                continue
            self.create({
                'name': r.name, 'date': new_date,
                'day_type': r.day_type, 'note': r.note,
            })
            created += 1
        return {'created': created}
