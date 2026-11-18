import { Op } from 'sequelize'
import { sequelize } from '../../config/base-de-datos.js'
import { Usuario, Persona, Perfil, Sesion } from '../../modelos/index.js'
import { NoEncontrado, DatosInvalidos, SinPermiso } from '../../errores.js'
import { registroDe } from '../../registro.js'
import { cifrarContrasena } from './acceso.servicio.js'
import { generarContrasenaProvisoria } from './acceso.reglas.js'
import { registrarEnBitacora } from '../bitacora/bitacora.servicio.js'
import { permisosDelUsuario } from '../../http/middlewares/autorizar.js'
import { puedeGestionarUsuario, esPerfilProtegido, esPerfilDeSoporte, MODULO_SOPORTE } from '../permisos/permisos.reglas.js'

const log = registroDe('usuarios')

const RELACIONES = [
  { model: Persona, as: 'persona', attributes: ['idPersona', 'apellidoNombre', 'telefonoWhatsapp', 'correo'] },
  { model: Perfil, as: 'perfil', attributes: ['idPerfil', 'nombre', 'descripcion'] },
]

// El usuario de soporte es del equipo que mantiene el sistema, no del comercio:
// quien no es soporte no lo ve en la nómina ni lo puede abrir.
const esSoporte = (permisos) => Boolean(permisos?.[MODULO_SOPORTE]?.escritura)

const idsPerfilesDeSoporte = async () => {
  const perfiles = await Perfil.findAll({ attributes: ['idPerfil'] })
  const ids = []
  for (const perfil of perfiles) {
    if (esPerfilDeSoporte(await permisosDelUsuario(perfil.idPerfil))) ids.push(perfil.idPerfil)
  }
  return ids
}

/** RF02.5 — nomina de usuarios con su perfil. El hash nunca sale: lo excluye
 *  el alcance por omision del modelo. */
export const listarUsuarios = async ({ texto, limit, offset }, permisosQuienPide) => {
  const filtro = {}
  if (texto?.trim()) {
    const como = { [Op.like]: `%${texto.trim()}%` }
    filtro[Op.or] = [{ nombreUsuario: como }, { '$persona.apellido_nombre$': como }]
  }
  if (!esSoporte(permisosQuienPide)) {
    const ocultos = await idsPerfilesDeSoporte()
    if (ocultos.length > 0) filtro.idPerfil = { [Op.notIn]: ocultos }
  }

  return Usuario.findAndCountAll({
    where: filtro,
    include: RELACIONES,
    order: [['activo', 'DESC'], ['nombreUsuario', 'ASC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  })
}

export const buscarUsuario = async (idUsuario) => {
  const usuario = await Usuario.findByPk(idUsuario, { include: RELACIONES })
  if (!usuario) throw new NoEncontrado('El usuario')
  return usuario
}

/** El mismo usuario, pero como lo ve quien pide: soporte no existe para el resto. */
export const buscarUsuarioVisible = async (idUsuario, permisosQuienPide) => {
  const usuario = await buscarUsuario(idUsuario)
  if (!esSoporte(permisosQuienPide) && esPerfilDeSoporte(await permisosDelUsuario(usuario.idPerfil))) {
    throw new NoEncontrado('El usuario')
  }
  return usuario
}

/**
 * RF02.4 — perfiles que se pueden asignar. El de soporte no se le da a nadie:
 * hay un solo usuario de soporte y se crea al instalar el sistema.
 */
export const listarPerfiles = async () => {
  const perfiles = await Perfil.findAll({ where: { activo: true }, order: [['idPerfil', 'ASC']] })
  const asignables = []
  for (const perfil of perfiles) {
    if (!esPerfilDeSoporte(await permisosDelUsuario(perfil.idPerfil))) asignables.push(perfil)
  }
  return asignables
}

/** Nadie recibe el perfil de soporte; el único que lo tiene lo conserva. */
const verificarPerfilAsignable = async (idPerfil, usuarioActual = null) => {
  if (usuarioActual?.idPerfil === idPerfil) return
  if (esPerfilDeSoporte(await permisosDelUsuario(idPerfil))) {
    throw new DatosInvalidos('El usuario de soporte es uno solo: se crea al instalar el sistema y no se le asigna a nadie más.')
  }
}

/** Corta la operacion si toca el perfil de soporte y quien pide no es soporte. */
const verificarAlcance = async (permisosQuienPide, ...idPerfiles) => {
  const { admite, motivo } = puedeGestionarUsuario({
    quienPide: permisosQuienPide,
    perfilesInvolucrados: await Promise.all(idPerfiles.map((id) => permisosDelUsuario(id))),
  })
  if (!admite) throw new SinPermiso(motivo)
}

const verificarPerfil = async (idPerfil, transaction) => {
  const perfil = await Perfil.findOne({ where: { idPerfil, activo: true }, transaction })
  if (!perfil) throw new NoEncontrado('El perfil')
  return perfil
}

const verificarNombreLibre = async (nombreUsuario, idActual = null) => {
  const donde = { nombreUsuario }
  if (idActual) donde.idUsuario = { [Op.ne]: idActual }

  if (await Usuario.count({ where: donde })) {
    throw new DatosInvalidos(`Ya existe un usuario "${nombreUsuario}".`)
  }
}

/**
 * RF02.1 — alta. Usuario es una especializacion de persona: las dos filas se
 * escriben juntas o no se escribe ninguna.
 */
export const registrarUsuario = async (datos, permisosQuienPide) => {
  await verificarAlcance(permisosQuienPide, datos.idPerfil)
  await verificarPerfilAsignable(datos.idPerfil)
  await verificarNombreLibre(datos.nombreUsuario)

  // El hash se calcula fuera de la transaccion: cifrar tarda y no tiene sentido
  // tener la transaccion abierta mientras tanto.
  const contrasenaHash = await cifrarContrasena(datos.contrasena)

  const idUsuario = await sequelize.transaction(async (transaction) => {
    await verificarPerfil(datos.idPerfil, transaction)

    const persona = await Persona.create({
      apellidoNombre: datos.apellidoNombre,
      tipoPersona: 'FISICA',
    }, { transaction })

    const usuario = await Usuario.create({
      idPersona: persona.idPersona,
      idPerfil: datos.idPerfil,
      nombreUsuario: datos.nombreUsuario,
      contrasenaHash,
    }, { transaction })

    await registrarEnBitacora({
      entidad: 'usuario',
      idRegistro: usuario.idUsuario,
      accion: 'ALTA',
      despues: {
        nombreUsuario: datos.nombreUsuario,
        apellidoNombre: datos.apellidoNombre,
        idPerfil: datos.idPerfil,
      },
    }, transaction)

    return usuario.idUsuario
  })

  log.info({ idUsuario, perfil: datos.idPerfil }, 'usuario dado de alta')
  return buscarUsuario(idUsuario)
}

/**
 * Impide dejar sin usuarios activos a un perfil protegido (Soporte o
 * Administrador). Sin Soporte nadie puede volver a configurar permisos ni dar
 * ese perfil desde adentro; sin Administrador el comercio no maneja sus
 * usuarios.
 */
const verificarNoEsElUltimo = async (usuario, accion) => {
  if (!esPerfilProtegido(usuario.perfil)) return
  const otros = await Usuario.count({
    where: { idPerfil: usuario.idPerfil, activo: true, idUsuario: { [Op.ne]: usuario.idUsuario } },
  })
  if (otros === 0) {
    throw new DatosInvalidos(`Es el único usuario activo con perfil ${usuario.perfil.nombre}: si ${accion}, nadie quedaría con ese perfil.`)
  }
}

/** RF02.2 y RF02.4 — modificacion de datos y de perfil. La contrasena no se
 *  toca desde aca: solo la cambia su dueno (RF01.3). */
export const modificarUsuario = async (idUsuario, datos, permisosQuienPide) => {
  const usuario = await buscarUsuario(idUsuario)
  await verificarAlcance(permisosQuienPide, usuario.idPerfil, datos.idPerfil)
  await verificarPerfilAsignable(datos.idPerfil, usuario)
  await verificarNombreLibre(datos.nombreUsuario, idUsuario)
  await verificarPerfil(datos.idPerfil)

  if (datos.idPerfil !== usuario.idPerfil) await verificarNoEsElUltimo(usuario, 'le cambiás el perfil')

  const antes = {
    nombreUsuario: usuario.nombreUsuario,
    apellidoNombre: usuario.persona.apellidoNombre,
    idPerfil: usuario.idPerfil,
  }

  await sequelize.transaction(async (transaction) => {
    await usuario.persona.update({ apellidoNombre: datos.apellidoNombre }, { transaction })
    await usuario.update({
      nombreUsuario: datos.nombreUsuario,
      idPerfil: datos.idPerfil,
    }, { transaction })

    await registrarEnBitacora({
      entidad: 'usuario',
      idRegistro: idUsuario,
      accion: 'MODIFICACION',
      antes,
      despues: {
        nombreUsuario: datos.nombreUsuario,
        apellidoNombre: datos.apellidoNombre,
        idPerfil: datos.idPerfil,
      },
    }, transaction)
  })

  log.info({ idUsuario, perfil: datos.idPerfil }, 'usuario modificado')
  return buscarUsuario(idUsuario)
}

/**
 * RF02.3 — baja LOGICA. El usuario no puede volver a entrar, pero las ventas y
 * los movimientos que registro quedan a su nombre: eso es todo el sentido de
 * que la baja sea logica y no un borrado.
 */
export const darDeBajaUsuario = async (idUsuario, idQuienPide, permisosQuienPide) => {
  if (idUsuario === idQuienPide) {
    throw new DatosInvalidos('No podés darte de baja a vos mismo.')
  }

  const usuario = await buscarUsuario(idUsuario)
  await verificarAlcance(permisosQuienPide, usuario.idPerfil)
  if (!usuario.activo) return

  await verificarNoEsElUltimo(usuario, 'lo das de baja')

  await sequelize.transaction(async (transaction) => {
    await usuario.update({ activo: false }, { transaction })

    // Dar de baja sin cerrar la sesion dejaria al usuario operando hasta que
    // venza el token, que es exactamente lo que la baja quiso impedir.
    await Sesion.update(
      { fechaCierre: new Date(), motivoCierre: 'REVOCADA' },
      { where: { idUsuario, fechaCierre: null }, transaction },
    )

    await registrarEnBitacora({
      entidad: 'usuario',
      idRegistro: idUsuario,
      accion: 'BAJA',
      antes: { activo: true, nombreUsuario: usuario.nombreUsuario },
      despues: { activo: false },
    }, transaction)
  })

  log.info({ idUsuario, nombreUsuario: usuario.nombreUsuario }, 'usuario dado de baja')
}

/**
 * RF02.2 — restablece la contraseña de quien se la olvidó. No hay correo ni
 * recuperación automática: la restablece quien administra los usuarios (el
 * Administrador a los empleados, Soporte al Administrador) y el sistema genera
 * una provisoria, que se ve una sola vez. Las sesiones abiertas del usuario se
 * cierran. El usuario la cambia después desde «Mi cuenta».
 */
export const restablecerContrasena = async (idUsuario, idQuienPide, permisosQuienPide) => {
  if (idUsuario === idQuienPide) {
    throw new DatosInvalidos('Para cambiar tu propia contraseña usá «Mi cuenta».')
  }

  const usuario = await buscarUsuario(idUsuario)
  await verificarAlcance(permisosQuienPide, usuario.idPerfil)
  if (!usuario.activo) throw new DatosInvalidos('El usuario está dado de baja: no puede iniciar sesión.')

  const contrasenaProvisoria = generarContrasenaProvisoria()
  const contrasenaHash = await cifrarContrasena(contrasenaProvisoria)

  await sequelize.transaction(async (transaction) => {
    await Usuario.update({ contrasenaHash }, { where: { idUsuario }, transaction })
    await Sesion.update(
      { fechaCierre: new Date(), motivoCierre: 'REVOCADA' },
      { where: { idUsuario, fechaCierre: null }, transaction },
    )
    await registrarEnBitacora({
      entidad: 'usuario',
      idRegistro: idUsuario,
      accion: 'MODIFICACION',
      detalle: `Contraseña restablecida para ${usuario.nombreUsuario}`,
    }, transaction)
  })

  log.info({ idUsuario }, 'contraseña restablecida')
  return { contrasenaProvisoria }
}
