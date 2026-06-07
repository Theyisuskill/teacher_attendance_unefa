/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class AttendanceKiosk extends Component {
    static template = "teacher_attendance.AttendanceKiosk";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            pin: "",
            selectedClassroom: null,
            classrooms: [],
            status: "idle", // 'idle', 'success', 'error', 'loading'
        });

        onWillStart(async () => {
            const aulas = await this.orm.searchRead("attendance.classroom", [], ["name", "code"]);
            this.state.classrooms = aulas;
        });
    }

    onNumberClick(num) {
        if (this.state.pin.length < 4) {
            this.state.pin += num;
        }
        if (this.state.pin.length === 4) {
            this.submitAttendance();
        }
    }

    clearPin() {
        this.state.pin = "";
    }

    async submitAttendance() {
        if (!this.state.selectedClassroom) {
            this.notification.add("Please select a classroom first.", { type: "warning" });
            this.state.pin = "";
            return;
        }

        this.state.status = "loading";
        try {
            const aula = this.state.classrooms.find(c => c.id == this.state.selectedClassroom);

            // Registro vía backend: valida PIN, método habilitado y entrada/salida
            const response = await this.orm.call(
                "attendance.log",
                "action_log_attendance_by_pin",
                [this.state.pin, aula.id]
            );

            if (response.status === 'invalid') {
                this.state.status = "error";
                this.notification.add(response.message || "PIN inválido.", { type: "danger" });
                this.state.pin = "";
                setTimeout(() => this.state.status = "idle", 2500);
                return;
            }

            this.state.status = "success";
            this.notification.add(response.message || `Bienvenido, ${response.teacher_name}!`, { type: "success" });
            this.state.pin = "";
            setTimeout(() => this.state.status = "idle", 3000);

        } catch (error) {
            this.state.status = "error";
            this.notification.add("Error al registrar asistencia.", { type: "danger" });
            this.state.pin = "";
            setTimeout(() => this.state.status = "idle", 2000);
        }
    }
}

registry.category("actions").add("attendance_kiosk_action", AttendanceKiosk);
