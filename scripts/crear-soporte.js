// Alta del primer usuario, con perfil Soporte.
//
// Existe por un problema de arranque: para dar de alta usuarios (RF02) hay que
// estar autenticado, y para autenticarse hace falta un usuario. Se corre una
// sola vez, con la base ya instalada:
//
//   npm run crear-soporte
//
// El primer usuario es de Soporte y no Administrador: solo Soporte configura
// perfiles y permisos y puede dar el perfil Soporte. Quien instala (el equipo
// de desarrollo) crea despues, desde el sistema, el usuario Administrador del
// titular del comercio.
//
// La contrasena se pide por entrada estandar y no se muestra al tipearla: si
// se pasara como argumento quedaria en el historial del shell y en la lista
// de procesos, visible para cualquiera con acceso a la maquina.

import { createInterface } from 'node:readline/promises'
import { preguntar, preguntarOculto, Abortar, abortar } from './consola.js'
import { sequelize } from '../src/config/base-de-datos.js'
import { Persona, Usuario, Perfil } from '../src/modelos/index.js'
import { cifrarContrasena } from '../src/modulos/acceso/acceso.servicio.js'


const verificarBaseLista = async () => {
  const perfil = await Perfil.findOne({ where: { nombre: 'Soporte' } })
  if (!perfil) abortar('No existe el perfil Soporte. Falta ejecutar gestion_comercial_datos.sql.')

  const yaHay = await Usuario.count({ where: { idPerfil: perfil.idPerfil } })
  if (yaHay > 0) abortar(`Ya hay ${yaHay} usuario(s) de soporte dados de alta. Este script se corre una sola vez.`)

  return perfil
}

const pedirDatos = async () => {
  const lector = createInterface({ input: process.stdin, output: process.stdout })

  try {
    console.log('\nAlta del primer usuario (perfil Soporte)\n')

    const apellidoNombre = await preguntar(lector, 'Apellido y nombre : ')
    if (!apellidoNombre) abortar('El apellido y el nombre son obligatorios.')

    const nombreUsuario = await preguntar(lector, 'Nombre de usuario : ')
    if (!nombreUsuario) abortar('El nombre de usuario es obligatorio.')

    const contrasena = await preguntarOculto(lector, 'Contrasena        : ')
    if (contrasena.length < 8) abortar('La contrasena necesita al menos 8 caracteres.')

    const repetida = await preguntarOculto(lector, 'Repetir contrasena: ')
    if (contrasena !== repetida) abortar('Las contrasenas no coinciden.')

    return { apellidoNombre, nombreUsuario, contrasena }
  } finally {
    lector.close()
  }
}

const darDeAlta = async ({ apellidoNombre, nombreUsuario, contrasena }, perfil) => {
  const contrasenaHash = await cifrarContrasena(contrasena)

  await sequelize.transaction(async (transaction) => {
    const persona = await Persona.create({ apellidoNombre, tipoPersona: 'FISICA' }, { transaction })

    await Usuario.create({
      idPersona: persona.idPersona,
      idPerfil: perfil.idPerfil,
      nombreUsuario,
      contrasenaHash,
    }, { transaction })
  })
}

const main = async () => {
  await sequelize.authenticate()

  const perfil = await verificarBaseLista()
  const datos = await pedirDatos()
  await darDeAlta(datos, perfil)

  console.log(`\nListo. Ya podes iniciar sesion como "${datos.nombreUsuario}".\n`)
}

try {
  await main()
} catch (error) {
  const mensaje = error instanceof Abortar ? error.message : `No se pudo crear el usuario de soporte: ${error.message}`
  console.error(`\n${mensaje}\n`)
  process.exitCode = 1
} finally {
  await sequelize.close().catch(() => {})
}
