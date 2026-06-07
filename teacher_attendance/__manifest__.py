# -*- coding: utf-8 -*-
{
    'name': 'Teacher Attendance',
    'version': '19.0.1.1.0',
    'category': 'Human Resources',
    'summary': 'Manage teacher attendance with QR codes, geolocation, and schedules.',
    'author': 'Odoo',
    'website': 'https://www.odoo.com',
    'depends': ['base', 'web', 'mail'],
    'data': [
        'security/security_groups.xml',
        'security/ir.model.access.csv',
        'data/security_params.xml',
        'data/cron.xml',
        'report/attendance_report_templates.xml',
        'views/academic_views.xml',
        'views/classroom_views.xml',
        'views/attendance_log_views.xml',
        'views/menu_views.xml',
        'views/attendance_dashboard_views.xml',
        'views/res_users_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            # Navbar global
            'teacher_attendance/static/src/components/navbar/unefa_nav.js',
            'teacher_attendance/static/src/components/navbar/unefa_nav.xml',
            'teacher_attendance/static/src/components/navbar/unefa_nav.scss',
            # Scanner (dashboard principal)
            'teacher_attendance/static/src/components/scanner/scanner.js',
            'teacher_attendance/static/src/components/scanner/scanner.xml',
            'teacher_attendance/static/src/components/scanner/scanner.scss',
            # Historial
            'teacher_attendance/static/src/components/history/history.js',
            'teacher_attendance/static/src/components/history/history.xml',
            'teacher_attendance/static/src/components/history/history.scss',
            # Firma digital
            'teacher_attendance/static/src/components/signature/signature.js',
            'teacher_attendance/static/src/components/signature/signature.xml',
            # Mapa de ocupación
            'teacher_attendance/static/src/components/occupancy_map/occupancy_map.js',
            'teacher_attendance/static/src/components/occupancy_map/occupancy_map.xml',
            'teacher_attendance/static/src/components/occupancy_map/occupancy_map.scss',
            # Modo kiosco
            'teacher_attendance/static/src/components/kiosk/kiosk.js',
            'teacher_attendance/static/src/components/kiosk/kiosk.xml',
            'teacher_attendance/static/src/components/kiosk/kiosk.scss',
            # Gestión de usuarios (admin)
            'teacher_attendance/static/src/components/user_manager/user_manager.js',
            'teacher_attendance/static/src/components/user_manager/user_manager.xml',
            'teacher_attendance/static/src/components/user_manager/user_manager.scss',
            # Gestión de aulas
            'teacher_attendance/static/src/components/classroom_manager/classroom_manager.js',
            'teacher_attendance/static/src/components/classroom_manager/classroom_manager.xml',
            'teacher_attendance/static/src/components/classroom_manager/classroom_manager.scss',
            # Gestión de materias
            'teacher_attendance/static/src/components/subject_manager/subject_manager.js',
            'teacher_attendance/static/src/components/subject_manager/subject_manager.xml',
            'teacher_attendance/static/src/components/subject_manager/subject_manager.scss',
            # Gestión de suplencias
            'teacher_attendance/static/src/components/substitution_manager/substitution_manager.js',
            'teacher_attendance/static/src/components/substitution_manager/substitution_manager.xml',
            'teacher_attendance/static/src/components/substitution_manager/substitution_manager.scss',
            # Configuración de métodos de registro
            'teacher_attendance/static/src/components/config_manager/config_manager.js',
            'teacher_attendance/static/src/components/config_manager/config_manager.xml',
            'teacher_attendance/static/src/components/config_manager/config_manager.scss',
            # Contingencia manual
            'teacher_attendance/static/src/components/contingency_manager/contingency_manager.js',
            'teacher_attendance/static/src/components/contingency_manager/contingency_manager.xml',
            'teacher_attendance/static/src/components/contingency_manager/contingency_manager.scss',
            # Visor de registros de asistencia (OWL — reemplaza vistas nativas)
            'teacher_attendance/static/src/components/attendance_viewer/attendance_viewer.js',
            'teacher_attendance/static/src/components/attendance_viewer/attendance_viewer.xml',
            'teacher_attendance/static/src/components/attendance_viewer/attendance_viewer.scss',
            # Análisis de asistencia (OWL)
            'teacher_attendance/static/src/components/attendance_analysis/attendance_analysis.js',
            'teacher_attendance/static/src/components/attendance_analysis/attendance_analysis.xml',
            'teacher_attendance/static/src/components/attendance_analysis/attendance_analysis.scss',
            # Carga horaria
            'teacher_attendance/static/src/components/schedule_manager/schedule_manager.js',
            'teacher_attendance/static/src/components/schedule_manager/schedule_manager.xml',
            'teacher_attendance/static/src/components/schedule_manager/schedule_manager.scss',
            # Widgets
            'teacher_attendance/static/src/widgets/location_picker/location_picker.js',
            'teacher_attendance/static/src/widgets/location_picker/location_picker.xml',
            # CSS global
            'teacher_attendance/static/src/css/unefa_global.scss',
            'teacher_attendance/static/src/css/attendance_kanban.scss',
            'teacher_attendance/static/src/css/attendance_form.scss',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
    'post_migrate': 'odoo.addons.teacher_attendance.hooks.post_migrate',
}
