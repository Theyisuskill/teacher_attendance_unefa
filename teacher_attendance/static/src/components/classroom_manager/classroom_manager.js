/** @odoo-module **/

import { Component, useState, onWillStart, onMounted, onWillUnmount, useRef } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

const VENEZUELA_CENTER = { lat: 10.4806, lng: -66.9036 };

export class ClassroomManager extends Component {
    static template = "teacher_attendance.ClassroomManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");
        this.mapRef = useRef("classroomMap");
        this.map = null;
        this.marker = null;

        this.state = useState({
            classrooms: [],
            filteredClassrooms: [],
            searchQuery: "",
            currentView: "list",
            editingClassroom: null,
            isLoading: true,
            formData: this._getEmptyForm(),
            mapLat: 0,
            mapLng: 0,
        });

        onWillStart(async () => {
            await this.loadData();
        });

        onWillUnmount(() => {
            this._destroyMap();
        });
    }

    _getEmptyForm() {
        return {
            name: "",
            code: "",
            latitude: 0,
            longitude: 0,
            radius: 20,
            check_schedule: false,
            tolerance_margin: 15,
        };
    }

    _destroyMap() {
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.marker = null;
        }
    }

    _initMap() {
        this._destroyMap();
        if (!window.L) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
            document.head.appendChild(link);

            const script = document.createElement("script");
            script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
            script.onload = () => this._createMap();
            document.head.appendChild(script);
        } else {
            this._createMap();
        }
    }

    _createMap() {
        if (!this.mapRef.el) return;

        const lat = this.state.formData.latitude || VENEZUELA_CENTER.lat;
        const lng = this.state.formData.longitude || VENEZUELA_CENTER.lng;
        const hasCoords = this.state.formData.latitude !== 0 && this.state.formData.longitude !== 0;
        const zoom = hasCoords ? 18 : 6;

        this.map = L.map(this.mapRef.el).setView([lat, lng], zoom);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap contributors",
        }).addTo(this.map);

        if (hasCoords) {
            this.marker = L.marker([lat, lng], { draggable: true }).addTo(this.map);
            this._bindMarkerEvents();
            this._addRadiusCircle();
        }

        this.map.on("click", (event) => {
            const pos = event.latlng;
            if (this.marker) {
                this.marker.setLatLng(pos);
            } else {
                this.marker = L.marker(pos, { draggable: true }).addTo(this.map);
                this._bindMarkerEvents();
            }
            this._updateMapCoords(pos.lat, pos.lng);
        });

        setTimeout(() => this.map.invalidateSize(), 200);
    }

    _bindMarkerEvents() {
        this.marker.on("dragend", (event) => {
            const pos = event.target.getLatLng();
            this._updateMapCoords(pos.lat, pos.lng);
        });
    }

    _addRadiusCircle() {
        if (this.radiusCircle) {
            this.radiusCircle.remove();
        }
        const lat = this.state.formData.latitude;
        const lng = this.state.formData.longitude;
        const radius = this.state.formData.radius || 20;
        if (lat && lng) {
            this.radiusCircle = L.circle([lat, lng], {
                radius: radius,
                color: "#6E8FC7",
                fillColor: "#6E8FC7",
                fillOpacity: 0.15,
                weight: 2,
            }).addTo(this.map);
        }
    }

    _updateMapCoords(lat, lng) {
        this.state.formData.latitude = lat;
        this.state.formData.longitude = lng;
        this.state.mapLat = lat;
        this.state.mapLng = lng;
        this._addRadiusCircle();
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            const classrooms = await this.orm.searchRead(
                "attendance.classroom",
                [],
                ["name", "code", "latitude", "longitude", "radius", "check_schedule", "tolerance_margin", "secret_key"],
                { order: "name asc" }
            );
            this.state.classrooms = classrooms;
            this.state.filteredClassrooms = classrooms;
        } catch (error) {
            this.notification.add("Error al cargar aulas", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.filterClassrooms();
    }

    filterClassrooms() {
        const query = this.state.searchQuery.toLowerCase();
        if (!query) {
            this.state.filteredClassrooms = this.state.classrooms;
            return;
        }
        this.state.filteredClassrooms = this.state.classrooms.filter(
            (c) =>
                c.name.toLowerCase().includes(query) ||
                c.code.toLowerCase().includes(query)
        );
    }

    showCreateForm() {
        this.state.editingClassroom = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
        this.state.mapLat = 0;
        this.state.mapLng = 0;
        setTimeout(() => this._initMap(), 100);
    }

    showEditForm(classroomId) {
        const c = this.state.classrooms.find((cr) => cr.id === classroomId);
        if (!c) return;

        this.state.editingClassroom = c;
        this.state.formData = {
            name: c.name || "",
            code: c.code || "",
            latitude: c.latitude || 0,
            longitude: c.longitude || 0,
            radius: c.radius || 20,
            check_schedule: c.check_schedule || false,
            tolerance_margin: c.tolerance_margin || 15,
        };
        this.state.mapLat = c.latitude || 0;
        this.state.mapLng = c.longitude || 0;
        this.state.currentView = "form";
        setTimeout(() => this._initMap(), 100);
    }

    cancelForm() {
        this._destroyMap();
        this.state.currentView = "list";
        this.state.editingClassroom = null;
        this.state.formData = this._getEmptyForm();
        this.state.mapLat = 0;
        this.state.mapLng = 0;
    }

    useMyLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((position) => {
                const { latitude, longitude } = position.coords;
                if (this.marker) {
                    this.marker.setLatLng([latitude, longitude]);
                } else if (this.map) {
                    this.marker = L.marker([latitude, longitude], { draggable: true }).addTo(this.map);
                    this._bindMarkerEvents();
                }
                if (this.map) {
                    this.map.setView([latitude, longitude], 18);
                }
                this._updateMapCoords(latitude, longitude);
            });
        }
    }

    async saveClassroom() {
        const { formData, editingClassroom } = this.state;

        if (!formData.name || !formData.code) {
            this.notification.add("Nombre y código son obligatorios", { type: "warning" });
            return;
        }

        try {
            if (editingClassroom) {
                await this.orm.write("attendance.classroom", [editingClassroom.id], {
                    name: formData.name,
                    code: formData.code,
                    latitude: formData.latitude,
                    longitude: formData.longitude,
                    radius: formData.radius,
                    check_schedule: formData.check_schedule,
                    tolerance_margin: formData.tolerance_margin,
                });
                this.notification.add("Aula actualizada correctamente", { type: "success" });
            } else {
                await this.orm.create("attendance.classroom", [{
                    name: formData.name,
                    code: formData.code,
                    latitude: formData.latitude,
                    longitude: formData.longitude,
                    radius: formData.radius,
                    check_schedule: formData.check_schedule,
                    tolerance_margin: formData.tolerance_margin,
                }]);
                this.notification.add("Aula creada correctamente", { type: "success" });
            }

            this._destroyMap();
            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar aula", { type: "danger" });
        }
    }

    async deleteClassroom(classroomId) {
        this.dialog.add(Dialog, {
            title: "Confirmar eliminación",
            body: "¿Está seguro de que desea eliminar esta aula? Se eliminarán también los horarios asociados.",
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.classroom", [classroomId]);
                    this.notification.add("Aula eliminada", { type: "success" });
                    await this.loadData();
                } catch (error) {
                    this.notification.add("No se puede eliminar el aula", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async downloadQR(classroomId) {
        try {
            const classroom = this.state.classrooms.find((c) => c.id === classroomId);
            if (!classroom) return;

            this.action.doAction({
                type: "ir.actions.act_url",
                url: `/web/content/?model=attendance.classroom&id=${classroomId}&field=qr_code&download=true&filename=${classroom.name}_QR.png`,
                target: "new",
            });
        } catch (error) {
            this.notification.add("Error al descargar QR", { type: "danger" });
        }
    }

    goBack() {
        this._destroyMap();
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_classroom_manager", ClassroomManager);
