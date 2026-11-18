// Restablece la contraseña de un usuario desde el servidor.
//
// Es para el único caso que el sistema no puede resolver desde adentro: que se
// olvide la contraseña el usuario de Soporte, que es quien restablece la del
// Administrador. Se corre en el servidor, con acceso a la base:
//
//   npm run restablecer-contrasena
//
// La contraseña nueva se pide por entrada estándar y no se muestra al tipearla.
// Cierra las sesiones abiertas del usuario y queda en la bitácora.

import { createInterface } from 'node:readline/promises'
import { preguntar, preguntarOculto, Abortar, abortar } from './consola.js'
import { sequelize } from '../src/config/base-de-datos.js'
import { Usuario, Sesion } from '../src/modelos/index.js'
import { cifrarContrasena } from '../src/modulos/acceso/acceso.servicio.js'
import { registrarEnBitacora } from '../src/modulos/bitacora/bitacora.servicio.js'

const pedirDatos = async () => {
  const lector = createInterface({ input: process.stdin, output: process.stdout })

  try {
    console.log('\nRestablecer una contraseña\n')

    const nombreUsuario = await preguntar(lector, 'Nombre de usuario : ')
    if (!nombreUsuario) abortar('El nombre de usuario es obligatorio.')

    const contrasena = await preguntarOculto(lector, 'Contraseña nueva  : ')
    if (contrasena.length < 8) abortar('La contraseña necesita al menos 8 caracteres.')

    const repetida = await preguntarOculto(lector, 'Repetir contraseña: ')
    if (contrasena !== repetida) abortar('Las contraseñas no coinciden.')

    return { nombreUsuario, contrasena }
  } finally {
    lector.close()
  }
}

const main = async () => {
  await sequelize.authenticate()

  const { nombreUsuario, contrasena } = await pedirDatos()
  const usuario = await Usuario.findOne({ where: { nombreUsuario } })
  if (!usuario) abortar(`No existe el usuario "${nombreUsuario}".`)
  if (!usuario.activo) abortar(`El usuario "${nombreUsuario}" está dado de baja.`)

  const contrasenaHash = await cifrarContrasena(contrasena)
  await sequelize.transaction(async (transaction) => {
    await Usuario.update({ contrasenaHash }, { where: { idUsuario: usuario.idUsuario }, transaction })
    await Sesion.update(
      { fechaCierre: new Date(), motivoCierre: 'REVOCADA' },
      { where: { idUsuario: usuario.idUsuario, fechaCierre: null }, transaction },
    )
    // Sin sesión no hay usuario en el contexto: queda a nombre del propio usuario.
    await registrarEnBitacora({
      entidad: 'usuario',
      idRegistro: usuario.idUsuario,
      accion: 'MODIFICACION',
      detalle: `Contraseña restablecida desde el servidor para ${usuario.nombreUsuario}`,
      idUsuario: usuario.idUsuario,
    }, transaction)
  })

  console.log(`\nListo. "${usuario.nombreUsuario}" ya puede entrar con la contraseña nueva.\n`)
}

try {
  await main()
} catch (error) {
  const mensaje = error instanceof Abortar ? error.message : `No se pudo restablecer la contraseña: ${error.message}`
  console.error(`\n${mensaje}\n`)
  process.exitCode = 1
} finally {
  await sequelize.close().catch(() => {})
}
