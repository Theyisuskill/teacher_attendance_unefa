/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { Dialog } from "@web/core/dialog/dialog";

export class ClassroomManager extends Component {
    static template = "teacher_attendance.ClassroomManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            classrooms: [],
            filteredClassrooms: [],
            searchQuery: "",
            currentView: "list",
            editingClassroom: null,
            isLoading: true,
            formData: this._getEmptyForm(),
            schedules: [],
        });

        onWillStart(async () => {
            await this.loadData();
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
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingClassroom = null;
        this.state.formData = this._getEmptyForm();
    }

    onFormFieldChange(field, value) {
        this.state.formData[field] = value;
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
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_classroom_manager", ClassroomManager);
