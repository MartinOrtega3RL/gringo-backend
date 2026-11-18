import { unlink } from 'node:fs/promises'
import { DatosInvalidos } from '../../errores.js'

// RF10.2 — la foto se analiza antes de crear la recepcion: hace falta saber quien
// emitio el comprobante (y darlo de alta si no esta) antes de poder guardarla,
// porque la recepcion no existe sin proveedor. Mientras la persona confirma, el
// analisis queda guardado aca, en memoria, junto con la foto ya subida.
//
// Si nadie crea la recepcion en el plazo, se borra la foto: no quedan archivos
// huerfanos en el disco. Si el servidor se reinicia, el analisis se pierde y se
// vuelve a subir la foto.

export const VIGENCIA_ANALISIS_MS = 30 * 60 * 1000

const pendientes = new Map()

const descartar = (archivo) => {
  const pendiente = pendientes.get(archivo)
  if (!pendiente) return
  clearTimeout(pendiente.reloj)
  pendientes.delete(archivo)
  return pendiente
}

export const guardarAnalisis = ({ archivo, ruta, idUsuario, analisis }) => {
  const reloj = setTimeout(() => {
    descartar(archivo)
    unlink(ruta).catch(() => {})
  }, VIGENCIA_ANALISIS_MS)
  // No retener el proceso abierto por un plazo pendiente.
  reloj.unref()
  pendientes.set(archivo, { ruta, idUsuario, analisis, reloj })
}

/** El analisis de esa foto, si es de quien lo pide y sigue vigente. No lo consume. */
export const verAnalisis = (archivo, idUsuario) => {
  const pendiente = pendientes.get(archivo)
  if (!pendiente || pendiente.idUsuario !== idUsuario) {
    throw new DatosInvalidos('El análisis de la foto venció. Subila de nuevo.')
  }
  return pendiente.analisis
}

/** La recepcion ya se creo: la foto pasa a ser suya y deja de ser pendiente. */
export const consumirAnalisis = (archivo) => {
  descartar(archivo)
}
