# El Gringo Celulares: servidor (API)

Servidor del sistema de gestión de «El Gringo Celulares» (Formosa): ventas, inventario, clientes y proveedores, servicio técnico y reportes. API REST con Node.js, Express 5, Sequelize y MySQL 8.

**Seminario de Integración**, Universidad de la Cuenca del Plata (Lic. en Sistemas de Información, Comisión U, Sede Formosa), 2026.
Britez Joaquín Emiliano · Ortega Minardi Martín · Rivero Ruth Camila

La interfaz está en el repositorio [gringo-frontend](https://github.com/MartinOrtega3RL/gringo-frontend).

## Requisitos

- Node.js 20.11 o superior
- MySQL 8.0.16 o superior (motor InnoDB)

## Instalación

### 1. Base de datos

Se ejecutan en orden, con un usuario de MySQL que pueda crear esquemas:

```bash
mysql -u root -p < basedatos/gestion_comercial_ddl.sql
mysql -u root -p < basedatos/gestion_comercial_datos.sql
mysql -u root -p < basedatos/verificar_instalacion.sql
```

El primero **borra y recrea** el esquema `gestion_comercial`. El segundo crea las vistas y carga los datos iniciales (perfiles, módulos, permisos, estados de la orden y medios de pago). El tercero no modifica nada: informa si la instalación quedó completa.

### 2. Servidor

```bash
npm install
cp .env.example .env
```

Completar `.env` con el usuario y la contraseña de MySQL, y generar el secreto de los tokens:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. Primer usuario

Para dar de alta usuarios hay que estar autenticado, y para autenticarse hace falta un usuario. Este comando crea el primero, con perfil **Soporte**; la contraseña se pide por consola y no se muestra:

```bash
npm run crear-soporte
```

Se ejecuta **una sola vez**: si ya existe un usuario de Soporte, se detiene. Desde el sistema, Soporte da de alta después al Administrador del comercio, y este a sus empleados.

### 4. Arranque

```bash
npm run dev      # desarrollo: http://localhost:3000
npm start        # producción
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor en desarrollo, con reinicio al guardar |
| `npm start` | Servidor en producción |
| `npm run crear-soporte` | Crea el primer usuario (Soporte), una sola vez |
| `npm run restablecer-contrasena` | Restablece una contraseña desde el servidor. Solo para el caso en que Soporte olvide la suya |

Las contraseñas olvidadas del resto se restablecen desde **Usuarios**: el Administrador a los empleados y Soporte al Administrador.

## Perfiles

| Perfil | Qué hace |
|---|---|
| Administrador | Todo el negocio: ventas, inventario y costos, clientes, servicio técnico, reportes y usuarios |
| Vendedor | Ventas, clientes y consulta del catálogo; registra ingresos de mercadería |
| Técnico | Servicio técnico, clientes y consulta del catálogo |
| Soporte | Perfiles, permisos, bitácora y la cuenta del Administrador. No accede a los datos del negocio |

## Estructura

```
basedatos/   Esquema, datos iniciales y verificación de la instalación
scripts/     Alta del primer usuario y restablecimiento de contraseñas
src/
  config/    Entorno validado al arrancar y conexión a la base
  modelos/   Mapeo Sequelize del esquema existente (nunca sync)
  modulos/   Un módulo por área: acceso, permisos, catálogo, existencias,
             recepciones, clientes, proveedores, ventas, pedidos, servicio,
             reportes, bitácora
  http/      Middlewares de autenticación, autorización y errores
```
