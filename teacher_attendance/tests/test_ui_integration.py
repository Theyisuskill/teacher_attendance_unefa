"""UI Integration tests for Teacher Attendance UNEFA module."""

from odoo.tests.common import TransactionCase


class TestUIIntegration(TransactionCase):
    """Test UI components and actions."""

    def setUp(self):
        super().setUp()
        self.env = self.env

    def test_all_client_actions_exist(self):
        """Verify all client actions are registered."""
        action_ids = [
            "teacher_attendance.action_user_manager",
            "teacher_attendance.action_classroom_manager",
            "teacher_attendance.action_subject_manager",
            "teacher_attendance.action_substitution_manager",
            "teacher_attendance.action_attendance_dashboard",
            "teacher_attendance.action_occupancy_map",
            "teacher_attendance.action_attendance_kiosk",
        ]

        for action_id in action_ids:
            try:
                action = self.env.ref(action_id)
                self.assertIsNotNone(action)
                self.assertEqual(action.type, "ir.actions.client")
            except ValueError:
                self.fail(f"Action {action_id} not found")

    def test_action_tags_are_valid(self):
        """Verify all action tags are correctly set."""
        expected_tags = {
            "teacher_attendance.action_user_manager": "action_user_manager",
            "teacher_attendance.action_classroom_manager": "action_classroom_manager",
            "teacher_attendance.action_subject_manager": "action_subject_manager",
            "teacher_attendance.action_substitution_manager": "action_substitution_manager",
            "teacher_attendance.action_attendance_dashboard": "attendance_scanner_action",
            "teacher_attendance.action_occupancy_map": "attendance_occupancy_map",
            "teacher_attendance.action_attendance_kiosk": "attendance_kiosk_action",
        }

        for action_id, expected_tag in expected_tags.items():
            action = self.env.ref(action_id)
            self.assertEqual(action.tag, expected_tag,
                           f"Action {action_id} has tag {action.tag}, expected {expected_tag}")

    def test_menu_items_exist(self):
        """Verify all menu items are registered."""
        menu_ids = [
            "teacher_attendance.menu_attendance_root",
            "teacher_attendance.menu_attendance_dashboard",
            "teacher_attendance.menu_occupancy_map",
            "teacher_attendance.menu_attendance_kiosk",
        ]

        for menu_id in menu_ids:
            try:
                menu = self.env.ref(menu_id)
                self.assertIsNotNone(menu)
            except ValueError:
                self.fail(f"Menu {menu_id} not found")

    def test_group_coordinator_exists(self):
        """Verify coordinator group exists."""
        try:
            group = self.env.ref("teacher_attendance.group_coordinator")
            self.assertIsNotNone(group)
            self.assertEqual(group.category_id.name, "Teacher Attendance")
        except ValueError:
            self.fail("group_coordinator not found")

    def test_orm_models_have_ui_views(self):
        """Verify models have kanban/form/tree views."""
        model_configs = {
            "attendance.classroom": ["form", "list"],
            "attendance.subject": ["form", "list"],
            "attendance.substitution": ["form", "list"],
            "attendance.log": ["kanban", "form", "tree"],
        }

        for model_name, expected_views in model_configs.items():
            for view_type in expected_views:
                views = self.env["ir.ui.view"].search([
                    ("model", "=", model_name),
                    ("type", "=", view_type),
                ])
                self.assertTrue(len(views) > 0,
                              f"No {view_type} view found for {model_name}")

    def test_attendance_views_have_unefa_class(self):
        """Verify attendance views have UNEFA branding class."""
        kanban_views = self.env["ir.ui.view"].search([
            ("model", "=", "attendance.log"),
            ("type", "=", "kanban"),
        ])

        for view in kanban_views:
            self.assertIn("o_unefa_view", view.arch,
                         f"View {view.name} missing o_unefa_view class")

    def test_classroom_views_have_unefa_class(self):
        """Verify classroom views have UNEFA branding class."""
        views = self.env["ir.ui.view"].search([
            ("model", "=", "attendance.classroom"),
        ])

        for view in views:
            self.assertIn("o_unefa_view", view.arch,
                         f"View {view.name} missing o_unefa_view class")
