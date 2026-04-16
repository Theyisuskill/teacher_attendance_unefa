# -*- coding: utf-8 -*-
from odoo.tests.common import TransactionCase
from odoo.exceptions import ValidationError

class TestAttendanceModels(TransactionCase):
    def setUp(self):
        super(TestAttendanceModels, self).setUp()
        self.classroom = self.env['attendance.classroom'].create({
            'name': 'Room 101',
            'code': 'R101',
            'latitude': 40.7128,
            'longitude': -74.0060,
            'radius': 20,
        })

    def test_qr_generation(self):
        self.assertTrue(self.classroom.qr_code, "QR code should be generated")
        self.assertTrue(self.classroom.secret_key, "Secret key should be auto-generated")

    def test_distance_calculation(self):
        # Valid Check-in (Same spot)
        log_valid = self.env['attendance.log'].create({
            'classroom_id': self.classroom.id,
            'latitude': 40.7128,
            'longitude': -74.0060,
        })
        self.assertEqual(log_valid.status, 'valid')
        self.assertAlmostEqual(log_valid.distance, 0.0)

        # Outside Check-in (Far away)
        log_outside = self.env['attendance.log'].create({
            'classroom_id': self.classroom.id,
            'latitude': 40.7306,
            'longitude': -73.9352,
        })
        self.assertEqual(log_outside.status, 'outside')
        self.assertGreater(log_outside.distance, 20.0)
