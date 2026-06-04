/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { Dialog } from "@web/core/dialog/dialog";

export class SubstitutionManager extends Component {
    static template = "teacher_attendance.SubstitutionManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            substitutions: [],
            filteredSubstitutions: [],
            searchQuery: "",
            currentView: "list",
            editingSubstitution: null,
            isLoading: true,
            formData: this._getEmptyForm(),
            classrooms: [],
            subjects: [],
            teachers: [],
            filterState: "all",
        });

        onWillStart(async () => {
            await this.loadData();
        });
    }

    _getEmptyForm() {
        return {
            classroom_id: false,
            subject_id: false,
            original_teacher_id: false,
            substitute_teacher_id: false,
            date: new Date().toISOString().split("T")[0],
            state: "draft",
        };
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            const [substitutions, classrooms, subjects, teachers] = await Promise.all([
                this.orm.searchRead(
                    "attendance.substitution",
                    [],
                    ["classroom_id", "subject_id", "original_teacher_id", "substitute_teacher_id", "date", "state"],
                    { order: "date desc" }
                ),
                this.orm.searchRead("attendance.classroom", [], ["name"], { order: "name asc" }),
                this.orm.searchRead("attendance.subject", [], ["name"], { order: "name asc" }),
                this.orm.searchRead("res.users", [], ["name"], { order: "name asc" }),
            ]);

            this.state.substitutions = substitutions;
            this.state.filteredSubstitutions = substitutions;
            this.state.classrooms = classrooms;
            this.state.subjects = subjects;
            this.state.teachers = teachers;
        } catch (error) {
            this.notification.add("Error al cargar datos", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.filterSubstitutions();
    }

    filterSubstitutions() {
        let filtered = this.state.substitutions;
        const query = this.state.searchQuery.toLowerCase();

        if (query) {
            filtered = filtered.filter(
                (s) =>
                    (s.classroom_id && s.classroom_id[1].toLowerCase().includes(query)) ||
                    (s.subject_id && s.subject_id[1].toLowerCase().includes(query)) ||
                    (s.original_teacher_id && s.original_teacher_id[1].toLowerCase().includes(query)) ||
                    (s.substitute_teacher_id && s.substitute_teacher_id[1].toLowerCase().includes(query))
            );
        }

        if (this.state.filterState !== "all") {
            filtered = filtered.filter((s) => s.state === this.state.filterState);
        }

        this.state.filteredSubstitutions = filtered;
    }

    setFilterState(state) {
        this.state.filterState = state;
        this.filterSubstitutions();
    }

    showCreateForm() {
        this.state.editingSubstitution = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
    }

    showEditForm(substitutionId) {
        const s = this.state.substitutions.find((sub) => sub.id === substitutionId);
        if (!s) return;

        this.state.editingSubstitution = s;
        this.state.formData = {
            classroom_id: s.classroom_id ? s.classroom_id[0] : false,
            subject_id: s.subject_id ? s.subject_id[0] : false,
            original_teacher_id: s.original_teacher_id ? s.original_teacher_id[0] : false,
            substitute_teacher_id: s.substitute_teacher_id ? s.substitute_teacher_id[0] : false,
            date: s.date || "",
            state: s.state || "draft",
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingSubstitution = null;
        this.state.formData = this._getEmptyForm();
    }

    onFormFieldChange(field, value) {
        this.state.formData[field] = value;
    }

    async saveSubstitution() {
        const { formData, editingSubstitution } = this.state;

        if (!formData.classroom_id || !formData.subject_id || !formData.original_teacher_id || !formData.substitute_teacher_id || !formData.date) {
            this.notification.add("Todos los campos son obligatorios", { type: "warning" });
            return;
        }

        try {
            if (editingSubstitution) {
                await this.orm.write("attendance.substitution", [editingSubstitution.id], {
                    classroom_id: formData.classroom_id,
                    subject_id: formData.subject_id,
                    original_teacher_id: formData.original_teacher_id,
                    substitute_teacher_id: formData.substitute_teacher_id,
                    date: formData.date,
                });
                this.notification.add("Suplencia actualizada correctamente", { type: "success" });
            } else {
                await this.orm.create("attendance.substitution", [{
                    classroom_id: formData.classroom_id,
                    subject_id: formData.subject_id,
                    original_teacher_id: formData.original_teacher_id,
                    substitute_teacher_id: formData.substitute_teacher_id,
                    date: formData.date,
                }]);
                this.notification.add("Suplencia creada correctamente", { type: "success" });
            }

            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar suplencia", { type: "danger" });
        }
    }

    async activateSubstitution(substitutionId) {
        try {
            await this.orm.write("attendance.substitution", [substitutionId], { state: "active" });
            this.notification.add("Suplencia activada", { type: "success" });
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al activar", { type: "danger" });
        }
    }

    async completeSubstitution(substitutionId) {
        try {
            await this.orm.write("attendance.substitution", [substitutionId], { state: "done" });
            this.notification.add("Suplencia completada", { type: "success" });
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al completar", { type: "danger" });
        }
    }

    async deleteSubstitution(substitutionId) {
        this.dialog.add(Dialog, {
            title: "Confirmar eliminación",
            body: "¿Está seguro de que desea eliminar esta suplencia?",
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.substitution", [substitutionId]);
                    this.notification.add("Suplencia eliminada", { type: "success" });
                    await this.loadData();
                } catch (error) {
                    this.notification.add("No se puede eliminar la suplencia", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    getStateBadgeClass(state) {
        const classes = {
            draft: "badge-draft",
            active: "badge-active",
            done: "badge-done",
            cancelled: "badge-cancelled",
        };
        return classes[state] || "badge-draft";
    }

    getStateLabel(state) {
        const labels = {
            draft: "Borrador",
            active: "Activa",
            done: "Completada",
            cancelled: "Cancelada",
        };
        return labels[state] || state;
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard");
    }
}

registry.category("actions").add("action_substitution_manager", SubstitutionManager);
