/** @odoo-module **/

import { Component, useRef, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { BarcodeVideoScanner } from "@web/core/barcode/barcode_video_scanner";
import { AttendanceHistory } from "../history/history";
import { SignaturePad } from "../signature/signature";

export class AttendanceScanner extends Component {
    static template = "teacher_attendance.AttendanceScanner";
    static components = { BarcodeVideoScanner, AttendanceHistory, SignaturePad };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.historyComponent = null;
        this.state = useState({
            isScanning: false,
            lastResult: null,
            status: 'idle', // 'idle', 'success', 'error', 'loading', 'signing'
            kpis: {
                todayCount: 0,
                activeAulas: 0,
                lateCount: 0,
                totalHours: 0,
                punctuality: 0,
            }
        });

        onWillStart(async () => {
            await this.loadKPIs();
        });
    }

    async loadKPIs() {
        const today = new Date().toISOString().split('T')[0];
        const [todayStats, monthStats] = await Promise.all([
            Promise.all([
                this.orm.silent.searchCount("attendance.log", [["check_in", ">=", today + " 00:00:00"]]),
                this.orm.silent.call("attendance.log", "read_group", [
                    [["check_in", ">=", today + " 00:00:00"]],
                    ["classroom_id"],
                    ["classroom_id"]
                ]),
                this.orm.silent.searchCount("attendance.log", [["check_in", ">=", today + " 00:00:00"], ["status", "=", "late"]]),
            ]),
            this.orm.silent.call("attendance.log", "get_teacher_stats", [])
        ]);

        this.state.kpis.todayCount = todayStats[0];
        this.state.kpis.activeAulas = todayStats[1].length;
        this.state.kpis.lateCount = todayStats[2];
        this.state.kpis.totalHours = monthStats.total_hours;
        this.state.kpis.punctuality = monthStats.punctuality;
    }

    async onResult(result) {
        this.state.isScanning = false;
        this.state.lastResult = result;
        this.state.status = 'signing';
    }

    async onSignatureSave(signature) {
        this.state.status = 'loading';
        
        try {
            const position = await this._getCurrentPosition();
            
            const response = await this.orm.call(
                "attendance.log",
                "action_log_attendance",
                [],
                {
                    secret_key: this.state.lastResult,
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    signature: signature,
                }
            );

            if (response.status === 'valid') {
                this.state.status = 'success';
                this.notification.add("Attendance marked successfully!", { type: "success" });
                await this.loadKPIs();
                if (this.historyComponent) {
                    await this.historyComponent.loadLogs();
                }
            } else {
                this.state.status = 'error';
                this.notification.add(response.message || "Attendance failed.", { type: "danger" });
            }
        } catch (error) {
            this.state.status = 'error';
            this.notification.add("An error occurred during scanning.", { type: "danger" });
        }
    }

    onSignatureCancel() {
        this.state.status = 'idle';
        this.state.lastResult = null;
    }

    onError(error) {
        this.state.isScanning = false;
        this.state.status = 'error';
        this.notification.add(error.message, { type: "danger" });
    }

    toggleScanner() {
        this.state.isScanning = !this.state.isScanning;
        this.state.status = 'idle';
    }

    _getCurrentPosition() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error("Geolocation is not supported by your browser."));
            } else {
                navigator.geolocation.getCurrentPosition(resolve, reject);
            }
        });
    }
}

registry.category("actions").add("attendance_scanner_action", AttendanceScanner);
