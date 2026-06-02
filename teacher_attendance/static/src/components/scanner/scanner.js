/** @odoo-module **/

import { Component, useRef, useState, onWillStart, onMounted, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { BarcodeVideoScanner } from "@web/core/barcode/barcode_video_scanner";
import { AttendanceHistory } from "../history/history";
import { SignaturePad } from "../signature/signature";
import { user } from "@web/core/user";

const FULLSCREEN_CLASS = "attendance-scanner-fullscreen";

export class AttendanceScanner extends Component {
    static template = "teacher_attendance.AttendanceScanner";
    static components = { BarcodeVideoScanner, AttendanceHistory, SignaturePad };

    setup() {
        this.notification = useService("notification");
        this.orm = useService("orm");
        this.action = useService("action");
        this.historyComponent = null;
        this.clockInterval = null;
        this.state = useState({
            isScanning: false,
            lastResult: null,
            lastQrType: null,
            status: 'idle',
            statusMessage: '',
            currentTime: '--:--',
            currentDate: '--',
            teacherName: 'Profesor',
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
            await this.loadTeacherInfo();
            this.updateClock();
        });

        onMounted(() => {
            this.clockInterval = setInterval(() => this.updateClock(), 1000);
            document.body.classList.add(FULLSCREEN_CLASS);
        });

        onWillUnmount(() => {
            if (this.clockInterval) {
                clearInterval(this.clockInterval);
            }
            document.body.classList.remove(FULLSCREEN_CLASS);
        });
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_log_my");
    }

    updateClock() {
        const now = new Date();
        this.state.currentTime = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.state.currentDate = now.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }

    async loadTeacherInfo() {
        const [userData] = await this.orm.searchRead(
            "res.users",
            [["id", "=", user.userId]],
            ["name", "partner_id"]
        );
        if (userData) {
            this.state.teacherName = userData.name;
        }
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

    _detectQrType(text) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(text)) {
            return 'classroom';
        }
        const cedulaRegex = /(\d{6,10})/;
        if (cedulaRegex.test(text)) {
            return 'teacher';
        }
        return 'classroom';
    }

    _extractCedula(text) {
        const match = text.match(/(\d{6,10})/);
        return match ? match[1] : null;
    }

    async onResult(result) {
        this.state.isScanning = false;
        this.state.lastResult = result;

        const qrType = this._detectQrType(result);
        this.state.lastQrType = qrType;

        if (qrType === 'teacher') {
            this.state.status = 'loading';
            this.state.statusMessage = 'Verificando carnet...';
            await this._handleTeacherCardQr(result);
        } else {
            this.state.status = 'signing';
        }
    }

    async _handleTeacherCardQr(qrText) {
        try {
            const cedula = this._extractCedula(qrText);
            if (!cedula) {
                this.state.status = 'error';
                this.state.statusMessage = 'Formato de carnet invalido';
                this.notification.add("No se pudo extraer la cedula del QR.", { type: "danger" });
                return;
            }

            const position = await this._getCurrentPosition().catch(() => null);

            const response = await this.orm.call(
                "attendance.log",
                "action_log_attendance_by_cedula",
                [],
                {
                    cedula: cedula,
                    latitude: position ? position.coords.latitude : 0,
                    longitude: position ? position.coords.longitude : 0,
                }
            );

            if (response.status === 'valid' || response.status === 'checkout') {
                this.state.status = 'success';
                this.state.statusMessage = response.message || 'Asistencia Registrada';
                this.notification.add(response.message || "Asistencia marcada!", { type: "success" });
                await this.loadKPIs();
                if (this.historyComponent) {
                    await this.historyComponent.loadLogs();
                }
            } else {
                this.state.status = 'error';
                this.state.statusMessage = response.message || 'Error';
                this.notification.add(response.message || "Error en el registro.", { type: "danger" });
            }
        } catch (error) {
            this.state.status = 'error';
            this.state.statusMessage = 'Error de conexion';
            this.notification.add("Error al procesar el carnet.", { type: "danger" });
        }

        setTimeout(() => {
            this.state.status = 'idle';
            this.state.statusMessage = '';
        }, 3000);
    }

    async onSignatureSave(signature) {
        this.state.status = 'loading';
        this.state.statusMessage = 'Registrando asistencia...';
        
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
                this.state.statusMessage = response.message || 'Asistencia Registrada';
                this.notification.add("Asistencia marcada correctamente!", { type: "success" });
                await this.loadKPIs();
                if (this.historyComponent) {
                    await this.historyComponent.loadLogs();
                }
            } else {
                this.state.status = 'error';
                this.state.statusMessage = response.message || 'Error';
                this.notification.add(response.message || "Error en el registro.", { type: "danger" });
            }
        } catch (error) {
            this.state.status = 'error';
            this.state.statusMessage = 'Error de conexion';
            this.notification.add("Ocurrio un error durante el escaneo.", { type: "danger" });
        }

        setTimeout(() => {
            this.state.status = 'idle';
            this.state.statusMessage = '';
        }, 3000);
    }

    onSignatureCancel() {
        this.state.status = 'idle';
        this.state.lastResult = null;
        this.state.lastQrType = null;
    }

    onError(error) {
        this.state.isScanning = false;
        this.state.status = 'error';
        this.state.statusMessage = error.message || 'Error de camara';
        this.notification.add(error.message, { type: "danger" });
    }

    toggleScanner() {
        this.state.isScanning = !this.state.isScanning;
        this.state.status = 'idle';
        this.state.lastQrType = null;
    }

    _getCurrentPosition() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error("Geolocalizacion no soportada."));
            } else {
                navigator.geolocation.getCurrentPosition(resolve, reject);
            }
        });
    }
}

registry.category("actions").add("attendance_scanner_action", AttendanceScanner);
