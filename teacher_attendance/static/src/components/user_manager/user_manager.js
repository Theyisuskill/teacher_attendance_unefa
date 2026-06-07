/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user as currentUser } from "@web/core/user";
import { Dialog } from "@web/core/dialog/dialog";

export class UserManager extends Component {
    static template = "teacher_attendance.UserManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            users: [],
            filteredUsers: [],
            searchQuery: "",
            filterRole: "",
            filterCategory: "",
            filterDedication: "",
            currentView: "list",
            editingUser: null,
            isLoading: true,
            formData: this._getEmptyForm(),
        });

        onWillStart(async () => {
            await this.loadData();
        });
    }

    _getEmptyForm() {
        return {
            name: "",
            login: "",
            email: "",
            phone: "",
            vat: "",
            attendance_role: "teacher",
            teacher_category: "",
            teacher_dedication: "",
            attendance_pin: "",
            new_password: "",
            confirm_password: "",
            active: true,
        };
    }

    get categoryLabels() {
        return {
            "":             "—",
            instructor:     "Instructor",
            asistente:      "Asistente",
            agregado:       "Agregado",
            asociado:       "Asociado",
            titular:        "Titular",
        };
    }

    get dedicationLabels() {
        return {
            "":        "—",
            completo:  "T. Completo",
            medio:     "Medio Tiempo",
            variable:  "T. Variable",
        };
    }

    async loadData() {
        this.state.isLoading = true;
        try {
            // share=false: excluye usuarios de portal; active_test:false: incluye inactivos
            const users = await this.orm.searchRead(
                "res.users",
                [["share", "=", false]],
                ["name", "login", "email", "phone", "vat", "attendance_role",
                 "teacher_category", "teacher_dedication",
                 "attendance_pin", "attendance_device_id", "active",
                 "failed_login_attempts", "lockout_until"],
                { order: "name asc", context: { active_test: false } }
            );

            this.state.users = users || [];
            this.state.filteredUsers = users || [];
        } catch (error) {
            console.error("Error loading users:", error);
            this.notification.add("Error al cargar datos", { type: "danger" });
            this.state.users = [];
            this.state.filteredUsers = [];
        }
        this.state.isLoading = false;
    }

    onSearchInput(ev) {
        this.state.searchQuery = ev.target.value;
        this.filterUsers();  // aplica también el filtro de rol activo
    }

    onFilterRole(ev)        { this.state.filterRole = ev.target.value;        this.filterUsers(); }
    onFilterCategory(ev)    { this.state.filterCategory = ev.target.value;    this.filterUsers(); }
    onFilterDedication(ev)  { this.state.filterDedication = ev.target.value;  this.filterUsers(); }

    filterUsers() {
        const q    = this.state.searchQuery.toLowerCase();
        const role = this.state.filterRole;
        const cat  = this.state.filterCategory;
        const ded  = this.state.filterDedication;
        this.state.filteredUsers = this.state.users.filter((u) => {
            const matchesText = !q
                || u.name.toLowerCase().includes(q)
                || u.login.toLowerCase().includes(q)
                || (u.email && u.email.toLowerCase().includes(q))
                || (u.vat  && u.vat.toLowerCase().includes(q));
            const matchesRole = !role || (u.attendance_role || "none") === role;
            const matchesCat  = !cat  || (u.teacher_category || "") === cat;
            const matchesDed  = !ded  || (u.teacher_dedication || "") === ded;
            return matchesText && matchesRole && matchesCat && matchesDed;
        });
    }

    showCreateForm() {
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
        this.state.currentView = "form";
    }

    showEditForm(userId) {
        const u = this.state.users.find((usr) => usr.id === userId);
        if (!u) return;
        this.state.editingUser = u;
        this.state.formData = {
            name: u.name || "",
            login: u.login || "",
            email: u.email || "",
            phone: u.phone || "",
            vat: u.vat || "",
            attendance_role: u.attendance_role || "none",
            teacher_category: u.teacher_category || "",
            teacher_dedication: u.teacher_dedication || "",
            attendance_pin: u.attendance_pin || "",
            new_password: "",
            confirm_password: "",
            active: u.active !== false,
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingUser = null;
        this.state.formData = this._getEmptyForm();
    }

    async saveUser() {
        const { formData, editingUser } = this.state;

        if (!formData.name || !formData.login) {
            this.notification.add("Nombre y login son obligatorios", { type: "warning" });
            return;
        }

        // Validación de contraseña (aplica si se llenó el campo)
        if (formData.new_password || formData.confirm_password) {
            if (formData.new_password !== formData.confirm_password) {
                this.notification.add("Las contraseñas no coinciden", { type: "warning" });
                return;
            }
            if (formData.new_password.length < 6) {
                this.notification.add("La contraseña debe tener al menos 6 caracteres", { type: "warning" });
                return;
            }
        }

        // Validación de login duplicado (solo al crear)
        if (!editingUser && formData.login) {
            const loginCount = await this.orm.searchCount(
                "res.users",
                [["login", "=", formData.login]],
                { context: { active_test: false } }
            );
            if (loginCount > 0) {
                this.notification.add(
                    `El usuario "${formData.login}" ya existe en el sistema. ` +
                    `Elija un nombre de usuario diferente.`,
                    { type: "danger" }
                );
                return;
            }
        }

        // Validación de cédula única
        if (formData.vat) {
            const vatCheck = await this.orm.call(
                "res.users",
                "attendance_check_vat",
                [formData.vat, editingUser ? editingUser.id : false]
            );
            if (!vatCheck.available) {
                this.notification.add(
                    `La cédula "${formData.vat}" ya está registrada para "${vatCheck.owner}". ` +
                    `Cada docente debe tener una cédula única.`,
                    { type: "danger", sticky: true }
                );
                return;
            }
        }

        try {
            const vals = {
                name: formData.name,
                email: formData.email,
                phone: formData.phone,
                vat: formData.vat,
                attendance_role: formData.attendance_role,
                teacher_category: formData.teacher_category || false,
                teacher_dedication: formData.teacher_dedication || false,
                attendance_pin: formData.attendance_pin || false,
                active: formData.active,
            };

            if (editingUser) {
                if (formData.new_password) {
                    vals.password = formData.new_password;
                }
                await this.orm.write("res.users", [editingUser.id], vals);
                this.notification.add(
                    formData.new_password
                        ? "Usuario y contraseña actualizados correctamente"
                        : "Usuario actualizado correctamente",
                    { type: "success" }
                );
            } else {
                if (!formData.email) {
                    this.notification.add("El email es obligatorio para nuevos usuarios", { type: "warning" });
                    return;
                }
                if (!formData.new_password) {
                    this.notification.add("Debe asignar una contraseña al nuevo usuario", { type: "warning" });
                    return;
                }
                vals.login = formData.login;
                vals.password = formData.new_password;
                await this.orm.create("res.users", [vals]);
                this.notification.add("Usuario creado correctamente. Ya puede iniciar sesión.", { type: "success" });
            }
            await this.loadData();
            this.cancelForm();
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar usuario", { type: "danger" });
        }
    }

    isLocked(u) {
        if (!u.lockout_until) return false;
        const until = new Date(u.lockout_until.replace(' ', 'T') + 'Z');
        return until > new Date();
    }

    lockRemainingText(u) {
        if (!u.lockout_until) return '';
        const until = new Date(u.lockout_until.replace(' ', 'T') + 'Z');
        const secs = Math.max(0, Math.floor((until - new Date()) / 1000));
        if (secs <= 0) return '';
        const mins = Math.floor(secs / 60);
        return mins > 0 ? `${mins} min` : `${secs}s`;
    }

    async unlockUser(userId) {
        try {
            await this.orm.call("res.users", "attendance_unlock_account", [userId]);
            this.notification.add("Cuenta desbloqueada correctamente", { type: "success" });
            await this.loadData();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al desbloquear cuenta", { type: "danger" });
        }
    }

    async releaseDevice(userId) {
        try {
            await this.orm.write("res.users", [userId], { attendance_device_id: false });
            this.notification.add("Dispositivo liberado. El próximo registro vinculará un nuevo dispositivo.", { type: "success" });
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al liberar dispositivo", { type: "danger" });
        }
    }

    async deleteUser(userId) {
        // Protección: no eliminar la propia cuenta
        if (userId === currentUser.userId) {
            this.notification.add("No puede eliminar su propia cuenta de usuario.", { type: "warning" });
            return;
        }
        this.dialog.add(Dialog, {
            title: "Confirmar eliminación",
            body: "¿Está seguro de que desea eliminar este usuario? Esta acción no se puede deshacer.",
            confirm: async () => {
                try {
                    await this.orm.unlink("res.users", [userId]);
                    this.notification.add("Usuario eliminado", { type: "success" });
                    await this.loadData();
                } catch (error) {
                    this.notification.add(
                        error.data?.message || "No se puede eliminar el usuario",
                        { type: "danger" }
                    );
                }
            },
            cancel: () => {},
        });
    }

    async toggleUserActive(userId) {
        // Protección: no desactivar la propia cuenta
        if (userId === currentUser.userId) {
            this.notification.add("No puede desactivar su propia cuenta.", { type: "warning" });
            return;
        }
        const u = this.state.users.find((usr) => usr.id === userId);
        if (!u) return;
        try {
            await this.orm.write("res.users", [userId], { active: !u.active });
            this.notification.add(
                u.active ? "Usuario desactivado" : "Usuario activado",
                { type: "success" }
            );
            await this.loadData();
        } catch (error) {
            this.notification.add("Error al cambiar estado", { type: "danger" });
        }
    }

    get roleLabels() {
        return {
            none: "Sin rol",
            teacher: "Docente",
            coordinator: "Coordinador",
            admin: "Administrador",
        };
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_user_manager", UserManager);