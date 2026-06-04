/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { Dialog } from "@web/core/dialog/dialog";

export class SubjectManager extends Component {
    static template = "teacher_attendance.SubjectManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            subjects: [],
            filteredSubjects: [],
            searchQuery: "",
            currentView: "list",
            editingSubject: null,
            isLoading: true,
            formData: this._getEmptyForm(),
            newSubjectName: "",
            newSubjectCode: "",
        });

        onWillStart(async () => {
            await this.loadData();
        });
    }

    _getEmptyForm() {
        return {
            name: "",
            code: "",
        };
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            const subjects = await this.orm.searchRead(
                "attendance.subject",
                [],
                ["name", "code"],
                { order: "name asc" }
            );
            this.state.subjects = subjects;
            this.state.filteredSubjects = subjects;
        } catch (error) {
            this.notification.add("Error al cargar materias", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.filterSubjects();
    }

    filterSubjects() {
        const query = this.state.searchQuery.toLowerCase();
        if (!query) {
            this.state.filteredSubjects = this.state.subjects;
            return;
        }
        this.state.filteredSubjects = this.state.subjects.filter(
            (s) =>
                s.name.toLowerCase().includes(query) ||
                (s.code && s.code.toLowerCase().includes(query))
        );
    }

    showCreateForm() {
        this.state.editingSubject = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
    }

    showEditForm(subjectId) {
        const s = this.state.subjects.find((sub) => sub.id === subjectId);
        if (!s) return;

        this.state.editingSubject = s;
        this.state.formData = {
            name: s.name || "",
            code: s.code || "",
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingSubject = null;
        this.state.formData = this._getEmptyForm();
    }

    onFormFieldChange(field, value) {
        this.state.formData[field] = value;
    }

    async saveSubject() {
        const { formData, editingSubject } = this.state;

        if (!formData.name) {
            this.notification.add("El nombre es obligatorio", { type: "warning" });
            return;
        }

        try {
            if (editingSubject) {
                await this.orm.write("attendance.subject", [editingSubject.id], {
                    name: formData.name,
                    code: formData.code,
                });
                this.notification.add("Materia actualizada correctamente", { type: "success" });
            } else {
                await this.orm.create("attendance.subject", [{
                    name: formData.name,
                    code: formData.code,
                }]);
                this.notification.add("Materia creada correctamente", { type: "success" });
            }

            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar materia", { type: "danger" });
        }
    }

    async deleteSubject(subjectId) {
        this.dialog.add(Dialog, {
            title: "Confirmar eliminación",
            body: "¿Está seguro de que desea eliminar esta materia?",
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.subject", [subjectId]);
                    this.notification.add("Materia eliminada", { type: "success" });
                    await this.loadData();
                } catch (error) {
                    this.notification.add("No se puede eliminar la materia", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async quickAdd() {
        if (!this.state.newSubjectName) {
            this.notification.add("Ingrese el nombre de la materia", { type: "warning" });
            return;
        }

        try {
            await this.orm.create("attendance.subject", [{
                name: this.state.newSubjectName,
                code: this.state.newSubjectCode,
            }]);
            this.notification.add("Materia agregada", { type: "success" });
            this.state.newSubjectName = "";
            this.state.newSubjectCode = "";
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al agregar materia", { type: "danger" });
        }
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard");
    }
}

registry.category("actions").add("action_subject_manager", SubjectManager);
