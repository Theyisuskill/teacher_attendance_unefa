# -*- coding: utf-8 -*-
import io
import json

import xlsxwriter
from odoo import fields, _
from odoo.http import Controller, request, route, content_disposition
from odoo.exceptions import AccessError

# Etiquetas de agrupación (espejo de GROUP_OPTIONS del front)
GROUP_LABELS = {
    'day': 'Día', 'week': 'Semana', 'month': 'Mes', 'quarter': 'Trimestre',
    'year': 'Año', 'teacher': 'Docente', 'subject': 'Asignatura',
    'section': 'Sección', 'status': 'Estatus',
}

# Referencia de la acción de reporte PDF por tipo
PDF_REPORT_REF = {
    'summary':  'teacher_attendance.action_report_attendance_summary',
    'detail':   'teacher_attendance.action_report_attendance_detail',
    'executed': 'teacher_attendance.action_report_attendance_executed',
}


def _fmt_date(s):
    """'YYYY-MM-DD' → 'DD/MM/YYYY'."""
    try:
        y, m, d = s.split('-')
        return '%s/%s/%s' % (d, m, y)
    except Exception:
        return s or ''


class AttendanceReportExport(Controller):

    @route('/teacher_attendance/report/export', type='http', auth='user')
    def export_report(self, **kw):
        kind = kw.get('kind', 'summary')
        fmt = kw.get('format', 'pdf')
        date_from = kw.get('date_from')
        date_to = kw.get('date_to')
        group_by = kw.get('group_by', 'month')

        statuses = [s for s in (kw.get('statuses') or '').split(',') if s]
        filters = {
            'teacher_id': kw.get('teacher_id') or False,
            'subject_id': kw.get('subject_id') or False,
            'section': kw.get('section') or False,
            'statuses': statuses,
        }

        Log = request.env['attendance.log']

        # Cómputo server-side desde la BD (las funciones validan Coordinación).
        try:
            if kind == 'summary':
                report = Log.generate_report(date_from, date_to, group_by, filters)
            elif kind == 'detail':
                report = Log.get_report_detail(date_from, date_to, filters)
            elif kind == 'executed':
                report = Log.get_executed_hours_report(date_from, date_to)
            else:
                return request.make_response(_('Tipo de reporte desconocido.'), [('Content-Type', 'text/plain')])
        except AccessError:
            return request.make_response(
                _('No tiene permisos para exportar este reporte.'),
                headers=[('Content-Type', 'text/plain; charset=utf-8')], status=403)

        generated = fields.Datetime.context_timestamp(Log, fields.Datetime.now()).strftime('Generado %d/%m/%Y %H:%M')
        meta = {
            'subtitle': 'Período: %s → %s' % (_fmt_date(date_from), _fmt_date(date_to)),
            'generated': generated,
            'group_label': GROUP_LABELS.get(group_by, 'Grupo'),
        }

        base = {'summary': 'reporte_resumen', 'detail': 'detalle_registros', 'executed': 'horas_ejecutadas'}[kind]
        filename = '%s_%s_%s' % (base, date_from or '', date_to or '')

        if fmt == 'xlsx':
            content = self._build_xlsx(kind, report, meta)
            return request.make_response(content, headers=[
                ('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                ('Content-Disposition', content_disposition(filename + '.xlsx')),
            ])
        else:
            pdf = request.env['ir.actions.report']._render_qweb_pdf(
                PDF_REPORT_REF[kind], res_ids=[], data={'report': report, 'meta': meta})
            pdf_bytes = pdf[0] if isinstance(pdf, (tuple, list)) else pdf
            return request.make_response(pdf_bytes, headers=[
                ('Content-Type', 'application/pdf'),
                ('Content-Disposition', content_disposition(filename + '.pdf')),
            ])

    # ── XLSX ────────────────────────────────────────────
    def _build_xlsx(self, kind, report, meta):
        output = io.BytesIO()
        wb = xlsxwriter.Workbook(output, {'in_memory': True})
        ws = wb.add_worksheet('Reporte')

        f_title = wb.add_format({'bold': True, 'font_size': 14, 'font_color': '#43618F'})
        f_sub = wb.add_format({'font_size': 9, 'font_color': '#718096'})
        f_hdr = wb.add_format({'bold': True, 'bg_color': '#5273A8', 'font_color': 'white',
                               'border': 1, 'align': 'center', 'valign': 'vcenter'})
        f_txt = wb.add_format({'border': 1})
        f_int = wb.add_format({'border': 1, 'num_format': '0', 'align': 'right'})
        f_hrs = wb.add_format({'border': 1, 'num_format': '0.0', 'align': 'right'})
        f_pct = wb.add_format({'border': 1, 'num_format': '0.0"%"', 'align': 'right'})
        f_foot = wb.add_format({'bold': True, 'bg_color': '#EEF2FA', 'border': 1})
        f_foot_n = wb.add_format({'bold': True, 'bg_color': '#EEF2FA', 'border': 1, 'num_format': '0', 'align': 'right'})
        f_foot_h = wb.add_format({'bold': True, 'bg_color': '#EEF2FA', 'border': 1, 'num_format': '0.0', 'align': 'right'})

        titles = {'summary': 'UNEFA · Reporte Estadístico de Asistencia',
                  'detail': 'UNEFA · Detalle de Registros de Asistencia',
                  'executed': 'UNEFA · Horas Acumuladas Ejecutadas'}
        ws.write(0, 0, titles.get(kind, 'UNEFA · Reporte'), f_title)
        ws.write(1, 0, meta.get('subtitle', ''), f_sub)
        ws.write(2, 0, meta.get('generated', ''), f_sub)
        start = 4

        if kind == 'summary':
            headers = [meta.get('group_label', 'Grupo'), 'Asistió', 'Retardo', 'Inasistencia',
                       'Fuera', 'Manual', 'Justificados', 'Horas', 'Total', 'Punt. %']
            for c, h in enumerate(headers):
                ws.write(start, c, h, f_hdr)
            ws.set_column(0, 0, 26)
            ws.set_column(1, 9, 11)
            ws.freeze_panes(start + 1, 0)

            def just(counts):
                return counts.get('late_justified', 0) + counts.get('absent_justified', 0)

            row = start + 1
            for r in report.get('rows', []):
                c = r['counts']
                ws.write(row, 0, r.get('label', ''), f_txt)
                ws.write_number(row, 1, c.get('valid', 0), f_int)
                ws.write_number(row, 2, c.get('late', 0), f_int)
                ws.write_number(row, 3, c.get('absent', 0), f_int)
                ws.write_number(row, 4, c.get('outside', 0), f_int)
                ws.write_number(row, 5, c.get('manual', 0), f_int)
                ws.write_number(row, 6, just(c), f_int)
                ws.write_number(row, 7, r.get('hours', 0), f_hrs)
                ws.write_number(row, 8, r.get('total', 0), f_int)
                ws.write_number(row, 9, r.get('punctuality', 0), f_pct)
                row += 1
            t = report.get('totals', {})
            tc = t.get('counts', {})
            ws.write(row, 0, 'TOTAL', f_foot)
            ws.write_number(row, 1, tc.get('valid', 0), f_foot_n)
            ws.write_number(row, 2, tc.get('late', 0), f_foot_n)
            ws.write_number(row, 3, tc.get('absent', 0), f_foot_n)
            ws.write_number(row, 4, tc.get('outside', 0), f_foot_n)
            ws.write_number(row, 5, tc.get('manual', 0), f_foot_n)
            ws.write_number(row, 6, just(tc), f_foot_n)
            ws.write_number(row, 7, t.get('hours', 0), f_foot_h)
            ws.write_number(row, 8, t.get('total', 0), f_foot_n)
            ws.write_number(row, 9, t.get('punctuality', 0), f_foot_n)

        elif kind == 'detail':
            headers = ['Docente', 'Asignatura', 'Sección', 'Tipo', 'Fecha', 'Entrada',
                       'Salida', 'Horas', 'Método', 'Estatus', 'Aval', 'Aprobó']
            for c, h in enumerate(headers):
                ws.write(start, c, h, f_hdr)
            widths = [22, 20, 14, 12, 11, 8, 8, 8, 12, 16, 14, 20]
            for c, w in enumerate(widths):
                ws.set_column(c, c, w)
            ws.freeze_panes(start + 1, 0)
            rows = report.get('rows', [])
            row = start + 1
            for r in rows:
                ws.write(row, 0, r.get('teacher', ''), f_txt)
                ws.write(row, 1, r.get('subject', ''), f_txt)
                ws.write(row, 2, r.get('section', ''), f_txt)
                ws.write(row, 3, r.get('activity_type', ''), f_txt)
                ws.write(row, 4, r.get('date', ''), f_txt)
                ws.write(row, 5, r.get('check_in', ''), f_txt)
                ws.write(row, 6, r.get('check_out', ''), f_txt)
                ws.write_number(row, 7, r.get('hours', 0), f_hrs)
                ws.write(row, 8, r.get('method', ''), f_txt)
                ws.write(row, 9, r.get('status', ''), f_txt)
                ws.write(row, 10, r.get('aval', ''), f_txt)
                ws.write(row, 11, r.get('approver', ''), f_txt)
                row += 1
            if rows:
                ws.autofilter(start, 0, start + len(rows), len(headers) - 1)

        elif kind == 'executed':
            headers = ['Docente', 'Clase', 'Asesoría', 'Defensa', 'Total']
            for c, h in enumerate(headers):
                ws.write(start, c, h, f_hdr)
            ws.set_column(0, 0, 26)
            ws.set_column(1, 4, 12)
            ws.freeze_panes(start + 1, 0)
            row = start + 1
            for r in report.get('rows', []):
                ws.write(row, 0, r.get('teacher_name', ''), f_txt)
                ws.write_number(row, 1, r.get('clase', 0), f_hrs)
                ws.write_number(row, 2, r.get('asesoria', 0), f_hrs)
                ws.write_number(row, 3, r.get('defensa', 0), f_hrs)
                ws.write_number(row, 4, r.get('total', 0), f_hrs)
                row += 1
            t = report.get('totals', {})
            ws.write(row, 0, 'TOTAL', f_foot)
            ws.write_number(row, 1, t.get('clase', 0), f_foot_h)
            ws.write_number(row, 2, t.get('asesoria', 0), f_foot_h)
            ws.write_number(row, 3, t.get('defensa', 0), f_foot_h)
            ws.write_number(row, 4, t.get('total', 0), f_foot_h)

        wb.close()
        output.seek(0)
        return output.read()
