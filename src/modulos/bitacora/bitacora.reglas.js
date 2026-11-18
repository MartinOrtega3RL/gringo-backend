// Reglas puras de la bitacora de operaciones (RF05).
// Limpia credenciales, recorta cadenas largas y deja solo lo que cambio.

export const ACCIONES_BITACORA = [
  'ALTA', 'MODIFICACION', 'BAJA', 'ANULACION', 'LOGIN', 'LOGOUT', 'AJUSTE',
]

const MAX_TEXTO = 200
const MAX_DETALLE = 300

const CLAVES_SENSIBLES = new Set([
  'contrasena',
  'contrasenahash',
  'contrasenaactual',
  'contrasenanueva',
  'password',
  'passwordhash',
])

const esClaveSensible = (clave) => {
  const normal = String(clave).toLowerCase()
  return CLAVES_SENSIBLES.has(normal) || normal.startsWith('token')
}

const recortarTexto = (texto, maximo = MAX_TEXTO) => {
  if (texto.length <= maximo) return texto
  return `${texto.slice(0, maximo - 1)}…`
}

const limpiarValor = (valor) => {
  if (valor === undefined || valor === null) return null
  if (typeof valor === 'string') return recortarTexto(valor)
  if (valor instanceof Date) return valor.toISOString()
  if (Array.isArray(valor)) return valor.map(limpiarValor)
  if (typeof valor === 'object') return limpiarObjeto(valor)
  return valor
}

export const limpiarObjeto = (objeto) => {
  if (!objeto || typeof objeto !== 'object') return null
  const plano = typeof objeto.get === 'function' ? objeto.get({ plain: true }) : objeto
  const limpio = {}

  for (const [clave, valor] of Object.entries(plano)) {
    if (esClaveSensible(clave) || valor === undefined || typeof valor === 'function') continue
    limpio[clave] = limpiarValor(valor)
  }

  return Object.keys(limpio).length > 0 ? limpio : null
}

// La bitacora registra todo, pero quien la lee es Soporte y los datos del
// negocio son del titular: costos y montos (rentabilidad, RF04.2) y los datos
// personales de clientes y proveedores se ocultan a quien no tiene acceso a
// esos modulos. Lo guardado no se toca.
const CLAVES_DE_COSTO = new Set(['preciocosto', 'costounitario', 'valorcosto', 'precio_costo', 'costo_unitario'])
const CLAVES_DE_MONTO = new Set(['montototal', 'recargofinanciacion', 'montopresupuestado', 'recargoaplicado', 'importe'])
const CLAVES_PERSONALES = new Set(['apellidonombre', 'numerodocumento', 'telefonowhatsapp', 'correo', 'domicilio', 'domicilioentrega'])
const ENTIDADES_CON_DATOS_PERSONALES = new Set(['cliente', 'proveedor'])

const quitar = (valor, claves) => {
  if (Array.isArray(valor)) return valor.map((v) => quitar(v, claves))
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor)
        .filter(([clave]) => !claves.has(String(clave).toLowerCase()))
        .map(([clave, interior]) => [clave, quitar(interior, claves)]),
    )
  }
  return valor
}

/** Costos y montos: se ocultan a quien no tiene acceso a Reportes. */
export const sinCostos = (valor) => quitar(valor, new Set([...CLAVES_DE_COSTO, ...CLAVES_DE_MONTO]))

/** Datos personales de clientes y proveedores: se ocultan a quien no tiene acceso al modulo. */
export const sinDatosPersonales = (valor, entidad) =>
  ENTIDADES_CON_DATOS_PERSONALES.has(String(entidad ?? '').toLowerCase()) ? quitar(valor, CLAVES_PERSONALES) : valor

const iguales = (a, b) => {
  if (a === b) return true
  if (a == null && b == null) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * RF05 — prepara `datosAntes`, `datosDespues` y `detalle` para persistir en
 * `bitacora`. Quita credenciales/tokens, recorta strings largos y, cuando hay
 * estado previo y posterior, conserva unicamente los campos que cambiaron.
 */
export const limpiarDatosBitacora = ({ antes = null, despues = null, detalle = null } = {}) => {
  const previo = limpiarObjeto(antes)
  const posterior = limpiarObjeto(despues)
  const detalleLimpio = detalle?.trim() ? recortarTexto(detalle.trim(), MAX_DETALLE) : null

  if (!previo && !posterior) {
    return { datosAntes: null, datosDespues: null, detalle: detalleLimpio }
  }

  if (!previo || !posterior) {
    return { datosAntes: previo, datosDespues: posterior, detalle: detalleLimpio }
  }

  const claves = new Set([...Object.keys(previo), ...Object.keys(posterior)])
  const diffAntes = {}
  const diffDespues = {}

  for (const clave of claves) {
    const valAntes = clave in previo ? previo[clave] : null
    const valDespues = clave in posterior ? posterior[clave] : null
    if (!iguales(valAntes, valDespues)) {
      diffAntes[clave] = valAntes
      diffDespues[clave] = valDespues
    }
  }

  return {
    datosAntes: Object.keys(diffAntes).length > 0 ? diffAntes : null,
    datosDespues: Object.keys(diffDespues).length > 0 ? diffDespues : null,
    detalle: detalleLimpio,
  }
}

