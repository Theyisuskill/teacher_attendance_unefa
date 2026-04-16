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
            // Find user by PIN
            const users = await this.orm.searchRead("res.users", [["attendance_pin", "=", this.state.pin]], ["name", "id"]);
            
            if (users.length === 0) {
                this.state.status = "error";
                this.notification.add("Invalid PIN.", { type: "danger" });
                this.state.pin = "";
                setTimeout(() => this.state.status = "idle", 2000);
                return;
            }

            const user = users[0];
            const aula = this.state.classrooms.find(c => c.id == this.state.selectedClassroom);
            
            // Manual call to log attendance (assuming coordinates of the room for kiosk)
            const response = await this.orm.call("attendance.log", "create", [{
                teacher_id: user.id,
                classroom_id: aula.id,
                latitude: 0, // Kiosk is fixed
                longitude: 0,
            }]);

            this.state.status = "success";
            this.notification.add(`Welcome, ${user.name}!`, { type: "success" });
            this.state.pin = "";
            setTimeout(() => this.state.status = "idle", 3000);

        } catch (error) {
            this.state.status = "error";
            this.state.pin = "";
            setTimeout(() => this.state.status = "idle", 2000);
        }
    }
}

registry.category("actions").add("attendance_kiosk_action", AttendanceKiosk);
