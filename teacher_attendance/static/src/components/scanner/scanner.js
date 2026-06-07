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
        // Caché de GPS: evita esperar cada vez que se registra asistencia
        this._gpsCache = null;   // { coords: {latitude, longitude}, ts: Date.now() }
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
            // Pre-fetch GPS en background para que el primer escaneo sea instantáneo
            this._prefetchGPS();
        });

        onWillUnmount(() => {
            if (this.clockInterval) {
                clearInterval(this.clockInterval);
            }
            document.body.classList.remove(FULLSCREEN_CLASS);
        });
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_log_my", { clearBreadcrumbs: true });
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
        // 1. ¿Es UUID de aula?
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(text)) {
            return 'classroom';
        }
        // 2. ¿Contiene cédula venezolana?
        // Normalizar primero (puntos/guiones/espacios) para cubrir:
        //   "12345678", "V-12345678", "12.345.678", "V-12.345.678 JUAN PÉREZ"
        const digits = this._extractCedula(text);
        if (digits) {
            return 'teacher';
        }
        return 'classroom';
    }

    _extractCedula(text) {
        // Normalizar: quitar puntos, guiones y espacios para manejar
        // todos los formatos comunes de cédula venezolana en QR de carnet.
        // Ejemplos soportados:
        //   "12345678"          → "12345678"
        //   "V-12345678"        → "12345678"
        //   "V-12.345.678"      → "12345678"
        //   "12.345.678 JUAN"   → "12345678"
        //   "CI:12345678"       → "12345678"
        const normalized = text.replace(/[-.\s]/g, '');
        const match = normalized.match(/\d{6,10}/);
        return match ? match[0] : null;
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
        // Validación de red: el método carnet requiere conexión activa al servidor
        if (!navigator.onLine) {
            this.state.status = 'error';
            this.state.statusMessage =
                'Sin conexión a la red. El lector de carnet requiere conectividad. ' +
                'Use el registro manual de contingencia o intente de nuevo.';
            this.notification.add(
                "Sin conexión. Use la Contingencia Manual si el problema persiste.",
                { type: "danger", sticky: true }
            );
            setTimeout(() => { this.state.status = 'idle'; this.state.statusMessage = ''; }, 5000);
            return;
        }

        try {
            const cedula = this._extractCedula(qrText);
            if (!cedula) {
                this.state.status = 'error';
                this.state.statusMessage = 'Formato de carnet invalido';
                this.notification.add("No se pudo extraer la cedula del QR.", { type: "danger" });
                return;
            }

            const cached = this._getCachedGPS();
            let gpsLat = 0, gpsLng = 0;
            if (cached) {
                gpsLat = cached.latitude;
                gpsLng = cached.longitude;
                this._prefetchGPS();
            } else {
                const position = await this._getCurrentPosition(1500).catch(() => null);
                if (position) {
                    gpsLat = position.coords.latitude;
                    gpsLng = position.coords.longitude;
                    this._saveGPSCache(position.coords);
                }
            }

            const response = await this.orm.call(
                "attendance.log",
                "action_log_attendance_by_cedula",
                [],
                {
                    cedula: cedula,
                    latitude: gpsLat,
                    longitude: gpsLng,
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

        // GPS optimizado: usar caché si está disponible (< 90s), sino esperar máx 1.5s
        const cached = this._getCachedGPS();
        let lat = 0, lng = 0;

        if (cached) {
            // Caché disponible → instantáneo, actualizar en background
            lat = cached.latitude;
            lng = cached.longitude;
            this.state.statusMessage = 'Registrando asistencia...';
            this._prefetchGPS();   // actualiza la caché sin bloquear
        } else {
            this.state.statusMessage = 'Obteniendo ubicación...';
            const position = await this._getCurrentPosition(1500);  // max 1.5s
            if (position) {
                lat = position.coords.latitude;
                lng = position.coords.longitude;
                this._saveGPSCache(position.coords);
            } else {
                this.state.statusMessage = 'GPS no disponible — registrando sin coordenadas...';
            }
        }

        this.state.statusMessage = 'Registrando asistencia...';

        try {
            const response = await this.orm.call(
                "attendance.log",
                "action_log_attendance",
                [],
                {
                    secret_key: this.state.lastResult,
                    latitude: lat,
                    longitude: lng,
                    signature: signature,
                    device_id: this._getDeviceId(),
                }
            );

            // 'valid'   → entrada/salida dentro del radio ✅
            // 'outside' → asistencia registrada pero fuera del radio ⚠️ (no es un error)
            // 'checkout'→ salida registrada ✅
            if (['valid', 'checkout'].includes(response.status)) {
                this.state.status = 'success';
                // Mostrar la hora CONFIRMADA por el servidor (no la del dispositivo)
                const serverTime = response.server_time
                    ? this._formatServerTime(response.server_time)
                    : null;
                this.state.statusMessage = serverTime
                    ? `${response.message || 'Asistencia Registrada'} — ${serverTime} (hora servidor)`
                    : response.message || 'Asistencia Registrada';
                this.notification.add("Asistencia marcada correctamente!", { type: "success" });
                await this.loadKPIs();
                if (this.historyComponent) await this.historyComponent.loadLogs();

            } else if (response.status === 'outside') {
                // Asistencia registrada pero fuera del radio GPS → mostrar advertencia
                this.state.status = 'success';
                this.state.statusMessage = response.message
                    || 'Asistencia registrada. Estás fuera del radio del aula — será revisada por el coordinador.';
                this.notification.add(
                    this.state.statusMessage,
                    { type: "warning" }
                );
                await this.loadKPIs();
                if (this.historyComponent) await this.historyComponent.loadLogs();

            } else {
                this.state.status = 'error';
                this.state.statusMessage = response.message || 'No se pudo registrar la asistencia';
                this.notification.add(response.message || "Error en el registro.", { type: "danger" });
            }
        } catch (error) {
            this.state.status = 'error';
            this.state.statusMessage = 'Error de comunicación con el servidor. Verifique su conexión.';
            this.notification.add("Error al registrar la asistencia.", { type: "danger" });
        }

        setTimeout(() => {
            this.state.status = 'idle';
            this.state.statusMessage = '';
        }, 4000);
    }

    onSignatureCancel() {
        this.state.status = 'idle';
        this.state.lastResult = null;
        this.state.lastQrType = null;
    }

    onError(error) {
        this.state.isScanning = false;
        this.state.status = 'error';

        let msg = error.message || 'Error de camara';
        const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        if (window.location.protocol !== 'https:' && !isLocal) {
            // getUserMedia solo funciona en contextos seguros
            msg = 'La cámara requiere una conexión segura (HTTPS). '
                + 'Acceda al sistema mediante una URL https:// para poder escanear.';
        } else if (error.name === 'NotAllowedError') {
            msg = 'Permiso de cámara denegado. Habilite el acceso a la cámara en su navegador.';
        } else if (error.name === 'NotFoundError') {
            msg = 'No se encontró ninguna cámara en este dispositivo.';
        }

        this.state.statusMessage = msg;
        this.notification.add(msg, { type: "danger" });
    }

    toggleScanner() {
        this.state.isScanning = !this.state.isScanning;
        this.state.status = 'idle';
        this.state.lastQrType = null;
    }

    retryScanner() {
        this.state.status = 'idle';
        this.state.statusMessage = '';
        this.state.lastResult = null;
        this.state.lastQrType = null;
        this.state.isScanning = true;   // reinicia la cámara automáticamente
    }

    /**
     * Obtiene la posición GPS del dispositivo.
     * Nunca rechaza — devuelve null si GPS no está disponible o tarda demasiado.
     * @param {number} timeoutMs - Tiempo máximo de espera en ms (default 8000)
     * @returns {Promise<GeolocationPosition|null>}
     */
    _getCurrentPosition(timeoutMs = 8000) {
        return new Promise((resolve) => {
            if (!navigator.geolocation) {
                resolve(null);
                return;
            }
            const timer = setTimeout(() => resolve(null), timeoutMs);
            navigator.geolocation.getCurrentPosition(
                (pos) => { clearTimeout(timer); resolve(pos); },
                ()    => { clearTimeout(timer); resolve(null); },  // error → null, no lanza
                { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 }
            );
        });
    }

    /**
     * Convierte una fecha UTC de Odoo ("2026-06-07 18:30:00") a hora local
     * del dispositivo en formato HH:MM para mostrarla como confirmación del servidor.
     */
    _formatServerTime(serverUtcStr) {
        try {
            const d = new Date(serverUtcStr.replace(' ', 'T') + 'Z');
            return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return null;
        }
    }

    // ── Gestión de caché GPS ──────────────────────────────

    _saveGPSCache(coords) {
        this._gpsCache = { latitude: coords.latitude, longitude: coords.longitude, ts: Date.now() };
    }

    _getCachedGPS(maxAgeMs = 90_000) {
        if (!this._gpsCache) return null;
        if (Date.now() - this._gpsCache.ts > maxAgeMs) return null;
        return { latitude: this._gpsCache.latitude, longitude: this._gpsCache.longitude };
    }

    /** Pre-obtiene GPS en background sin bloquear la UI. */
    _prefetchGPS() {
        this._getCurrentPosition(6000).then(pos => {
            if (pos) this._saveGPSCache(pos.coords);
        });
    }

    /**
     * Identificador persistente del dispositivo (localStorage).
     * Usado para la validación de dispositivo vinculado: evita que
     * un docente registre asistencia desde el equipo de otro.
     */
    _getDeviceId() {
        let deviceId = localStorage.getItem("unefa_device_id");
        if (!deviceId) {
            deviceId = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem("unefa_device_id", deviceId);
        }
        return deviceId;
    }
}

registry.category("actions").add("attendance_scanner_action", AttendanceScanner);
