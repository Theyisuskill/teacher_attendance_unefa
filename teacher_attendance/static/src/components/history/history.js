/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";

export class AttendanceHistory extends Component {
    static template = "teacher_attendance.AttendanceHistory";

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            logs: [],
        });

        onWillStart(async () => {
            await this.loadLogs();
            if (this.props.onRegister) {
                this.props.onRegister(this);
            }
        });
    }

    async loadLogs() {
        const logs = await this.orm.searchRead(
            "attendance.log",
            [["teacher_id", "=", user.userId]],
            ["check_in", "classroom_id", "status", "distance"],
            { limit: 10, order: "check_in desc" }
        );
        this.state.logs = logs;
    }
}
