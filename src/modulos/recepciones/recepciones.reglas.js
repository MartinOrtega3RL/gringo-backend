// Reglas puras de recepcion de mercaderia y extraccion OCR (RF10 / S04).

const DESCARTE_INICIO = /^(?:sub\s*-?\s*total|total(?:\s+general|\s+a\s+pagar|\s+neto)?|iva(?:\s+\d+(?:[.,]\d+)?%?)?|c\.?u\.?i\.?t\.?|c\.?u\.?i\.?l\.?|d\.?n\.?i\.?|ingresos?\s+brutos|i\.?i\.?b\.?b\.?|fecha|hora|c\.?a\.?e\.?|vto\.?|vio\.?\s*cae|vencimiento|condici[oó]n(?:\s+de)?\s+venta|forma\s+de\s+pago|medio\s+de\s+pago|efectivo|transferencia|tarjeta|cambio|vuelto|descuento|recargo|bonificaci[oó]n|percepci[oó]n|retenci[oó]n|impuesto|env[ií]o|flete|saldo|cliente|domicilio|direcci[oó]n|localidad|raz[oó]n\s+social|factura(?:\s+[abc])?|remito|ticket|nro\.?|n[uú]mero|comprobante|punto\s+de\s+venta|cant\.?(?:idad)?|descripci[oó]n|detalle|art[ií]culo|producto|c[oó]digo|precio|p\.?\s*unit\.?|p\.?\s*total|importe|p[aá]gina)\b/i

const PALABRAS_VACIAS = new Set(['para', 'con', 'sin', 'por', 'los', 'las', 'del', 'una', 'uno', 'tipo', 'modelo'])

// Patron tolerante a puntos/comas de miles y decimales (ej: 12.990,00 / 7,500,00 / 1500.50 / 1.500)
const MONTO = '\\d+(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?'
const RX_MULT_INICIO = new RegExp(`^(\\d{1,4})\\.?\\s*[xX×]\\s*(?:u\\.?|un\\.?|u\\/)?\\s*\\$?\\s*(${MONTO})\\s+(.+)$`)
const RX_MULT_FINAL = new RegExp(`^(.*?)\\s+\\$?\\s*(${MONTO})$`)
const RX_MULT_DESC = new RegExp(`^(.+?)\\s+(\\d{1,4})\\.?\\s*[xX×]\\s*\\$?\\s*(${MONTO})(?:\\s+\\$?\\s*(${MONTO}))?$`)
const RX_TABULAR = new RegExp(`^(\\d{1,4})\\.?(?:\\s*(?:u\\.?|un\\.?|uni\\.?|pza\\.?|pz\\.?))?\\s+(.+?)\\s+(?:\\$?\\s*(${MONTO})\\s+)?\\$?\\s*(${MONTO})$`)
const RX_DESC_CANT = new RegExp(`^(.+?)\\s+(\\d{1,4})(?:\\s*(?:u\\.?|un\\.?|uni\\.?|pza\\.?|pz\\.?))?\\s+\\$?\\s*(${MONTO})(?:\\s+\\$?\\s*(${MONTO}))?$`)
const RX_DOS_MONTOS = new RegExp(`^(.+?)\\s+\\$?\\s*(${MONTO})\\s+\\$?\\s*(${MONTO})$`)

const redondear2 = (n) => Math.round(n * 100) / 100

/**
 * Convierte un importe en formato argentino o con ruido OCR de separadores
 * ($ 1.234,50 / 7,500,00 / 12.990.00 / 850,25 / 1.500) a Number.
 */
export const parsearNumeroAr = (crudo) => {
  if (!crudo) return null
  const limpio = String(crudo).replace(/[$\s]/g, '').trim()
  if (!limpio || !/\d/.test(limpio)) return null

  let normalizado = limpio
  const conDecimales = limpio.match(/^(\d+(?:[.,]\d{3})*)[.,](\d{1,2})$/)
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(limpio)) {
    // 1.500 o 1,500 o 1.234.567 -> separadores de miles sin decimales
    normalizado = limpio.replace(/[.,]/g, '')
  } else if (conDecimales) {
    // El ultimo bloque de 1-2 digitos tras punto o coma es la parte decimal
    // (cubre "12.990,00", "7,500,00", "7.500.00" y "850,25").
    normalizado = `${conDecimales[1].replace(/[.,]/g, '')}.${conDecimales[2]}`
  }

  const valor = Number(normalizado)
  return Number.isFinite(valor) && valor >= 0 ? redondear2(valor) : null
}

const limpiarDescripcion = (texto) =>
  String(texto ?? '')
    .replace(/\s+/g, ' ')
    // Restos del borde izquierdo de la tabla: "= Bateria", "=//. + Cables",
    // "De > Pin", ") - a Modulo". Los simbolos no empiezan una descripcion.
    .replace(/^(?:(?:[A-Za-z]{1,2}\s*)?[=|>)\]/.+_<-]+\s*)+/, '')
    .replace(/^[a-z]\s+(?=[A-ZÁÉÍÓÚÑ])/, '')
    .replace(/^[-–—•·*:\s]+|[-–—•·*:\s]+$/g, '')
    .slice(0, 200)

const descripcionValida = (desc) =>
  desc.length >= 2 &&
  !DESCARTE_INICIO.test(desc) &&
  /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2,}/.test(desc)

const normalizarLineaOcr = (cruda) =>
  cruda
    .replace(/[|[\]{}—–_]+/g, ' ')
    // Barra del borde derecho pegada al importe: "$1.500,00/"
    .replace(/(\d[.,]\d{1,2})\/+/g, '$1')
    // Separador de miles leido como espacio: "$1 500.00"
    .replace(/\$\s?(\d{1,3}) (\d{3}[.,]\d{1,2})\b/g, '$$$1$2')
    // Quita guiones heredados de bordes pegados al signo pesos
    .replace(/-\s*\$/g, '$')
    .replace(/\s+/g, ' ')
    .trim()
    // Quita ruido corto al inicio producido por bordes o fondo oscuro antes de la cantidad
    .replace(/^(?:[.,;:<>+•_*=]+\s*|(?:[a-zA-Z]{1,2}\s+){1,2})(?=\d{1,4}\.?\s+[A-Za-zÁÉÍÓÚÑ])/, '')
    // Quita restos cortos sin importe real al final de la fila (p. ej. "— B", "PE")
    .replace(/(\d[.,]\d{1,2})\s+(?:[^0-9]{1,12}|(?:[a-zA-Z0-9<>]{1,3}\s*){1,4})$/, '$1')
    .trim()

/** Quita un eventual codigo/SKU inicial de factura mayorista antes de la linea. */
const sinCodigoInicial = (linea) =>
  linea.replace(/^(?:[A-Z]{2,5}[-/]?\d{2,}|0\d{3,}|\d{5,12})\s+/i, '')

const esLineaDescartable = (linea) => {
  if (!linea || linea.length < 4) return true
  if (/^[-=_.*#\s]+$/.test(linea)) return true
  if (DESCARTE_INICIO.test(linea)) return true
  if (/\b(?:cuit|cuil|cae|iibb|subtotal|iva\s*\d|total\s*:?\s*\$?)\b/i.test(linea)) return true
  return false
}

/**
 * Cuando una fila trae cantidad OCR + precio unitario + precio total,
 * valida coherencia aritmetica: si un borde vertical pegado al "1" hizo leer
 * "11" pero total / unitario es un entero exacto (p. ej. 1), corrige cantidad.
 */
const resolverCantidadYCosto = (cantidadLeida, unitario, total) => {
  if (unitario === null) {
    return { cantidad: cantidadLeida, precioCosto: redondear2(total / cantidadLeida) }
  }

  const toleranciaLeida = Math.max(1, total * 0.02)
  if (Math.abs(unitario * cantidadLeida - total) <= toleranciaLeida) {
    return { cantidad: cantidadLeida, precioCosto: redondear2(total / cantidadLeida) }
  }

  if (unitario > 0 && total >= unitario) {
    const razon = total / unitario
    const entero = Math.round(razon)
    if (entero >= 1 && entero <= 9999 && Math.abs(razon - entero) <= 0.02) {
      return { cantidad: entero, precioCosto: unitario }
    }
  }

  return { cantidad: cantidadLeida, precioCosto: unitario }
}

const parsearLineaMultInicio = (linea) => {
  const m = linea.match(RX_MULT_INICIO)
  if (!m) return null
  const cantidad = Number(m[1])
  const precio = parsearNumeroAr(m[2])
  let resto = m[3].trim()
  const trailing = resto.match(RX_MULT_FINAL)
  if (trailing && parsearNumeroAr(trailing[2]) !== null) {
    resto = trailing[1]
  }
  const descripcionOriginal = limpiarDescripcion(resto)
  if (!cantidad || cantidad <= 0 || precio === null || !descripcionValida(descripcionOriginal)) return null
  return { descripcionOriginal, cantidad, precioCosto: precio }
}

const parsearLineaMultDesc = (linea) => {
  const m = linea.match(RX_MULT_DESC)
  if (!m) return null
  const descripcionOriginal = limpiarDescripcion(m[1])
  const cantidad = Number(m[2])
  const precio = parsearNumeroAr(m[3])
  if (!cantidad || cantidad <= 0 || precio === null || !descripcionValida(descripcionOriginal)) return null
  return { descripcionOriginal, cantidad, precioCosto: precio }
}

const parsearLineaTabular = (linea) => {
  const m = linea.match(RX_TABULAR)
  if (!m) return null

  const cantidadLeida = Number(m[1])
  const descripcionOriginal = limpiarDescripcion(m[2])
  const primero = m[3] ? parsearNumeroAr(m[3]) : null
  const ultimo = parsearNumeroAr(m[4])

  if (!cantidadLeida || cantidadLeida <= 0 || ultimo === null || !descripcionValida(descripcionOriginal)) return null
  const { cantidad, precioCosto } = resolverCantidadYCosto(cantidadLeida, primero, ultimo)
  return { descripcionOriginal, cantidad, precioCosto }
}

const parsearLineaDescCant = (linea) => {
  // Ej: "Funda Silicona A54   2   $ 1.500,00   $ 3.000,00"
  const m = linea.match(RX_DESC_CANT)
  if (!m) return null

  const rawDesc = m[1].trim()
  if (/[:]$/.test(rawDesc)) return null
  const descripcionOriginal = limpiarDescripcion(rawDesc)
  const cantidad = Number(m[2])
  const primero = parsearNumeroAr(m[3])
  const ultimo = m[4] ? parsearNumeroAr(m[4]) : null

  if (!cantidad || cantidad <= 0 || primero === null || !descripcionValida(descripcionOriginal)) return null

  if (ultimo !== null) {
    const tolerancia = Math.max(1, ultimo * 0.02)
    if (Math.abs(primero * cantidad - ultimo) > tolerancia) return null
    return { descripcionOriginal, cantidad, precioCosto: primero }
  }

  // Con un solo monto tras descripcion+cantidad, exigir que cantidad tenga sufijo o evitar confundir modelos (ej. "A54")
  if (!new RegExp(`\\s${cantidad}\\s*(?:u\\.?|un\\.?|uni\\.?|pza\\.?|pz\\.?)\\s`, 'i').test(linea)) {
    return null
  }
  return { descripcionOriginal, cantidad, precioCosto: primero }
}

const parsearLineaDosMontosSinCant = (linea) => {
  // Si el borde izquierdo tapa la cantidad o la convierte en "l"/"I",
  // infiere cantidad desde P. Unitario y P. Total.
  const limpiaInicio = linea.replace(/^(?:[lI]\s+)/, '')
  const m = limpiaInicio.match(RX_DOS_MONTOS)
  if (!m) return null

  const rawDesc = m[1].trim()
  if (/[:]$/.test(rawDesc)) return null
  const descripcionOriginal = limpiarDescripcion(rawDesc)
  const unitario = parsearNumeroAr(m[2])
  const total = parsearNumeroAr(m[3])

  if (!unitario || unitario <= 0 || total === null || total < unitario) return null
  if (!descripcionValida(descripcionOriginal) || descripcionOriginal.length < 3) return null

  const razon = total / unitario
  const cantidad = Math.round(razon)
  if (cantidad < 1 || cantidad > 9999 || Math.abs(razon - cantidad) > 0.03) return null

  return { descripcionOriginal, cantidad, precioCosto: unitario }
}

/**
 * RF10.2 — extrae lineas de un texto reconocido por OCR de una factura o
 * ticket argentino. Nunca lanza excepciones ante lineas ilegibles: las descarta.
 */
export const extraerLineas = (texto) => {
  if (!texto || typeof texto !== 'string') return []

  const lineas = []
  for (const cruda of texto.split(/\r?\n/)) {
    const normalizada = normalizarLineaOcr(cruda)
    if (esLineaDescartable(normalizada)) continue

    const candidata = sinCodigoInicial(normalizada)
    const parsed =
      parsearLineaMultInicio(candidata) ||
      parsearLineaMultDesc(candidata) ||
      parsearLineaTabular(candidata) ||
      parsearLineaDescCant(candidata) ||
      parsearLineaDosMontosSinCant(candidata)

    if (parsed && Number.isFinite(parsed.precioCosto) && parsed.precioCosto >= 0) {
      lineas.push(parsed)
    }
  }

  return lineas
}

/** Suma en centavos del monto total de las lineas de una recepcion. */
export const calcularTotalRecepcion = (lineas = []) => {
  const totalCentavos = lineas.reduce((acc, linea) => {
    const cantidad = Number(linea.cantidad) || 0
    const costoCentavos = Math.round((Number(linea.precioCosto) || 0) * 100)
    return acc + cantidad * costoCentavos
  }, 0)
  return totalCentavos / 100
}

// Importes impresos al pie del comprobante. Cada etiqueta ocupa su renglon: no se
// confunde con una linea de articulo, y el porcentaje de "IVA (21%)" no se toma
// por el importe.
const RX_PIE = {
  subtotal: new RegExp(`^sub\\s*-?\\s*total\\s*:?\\s*\\$?\\s*(${MONTO})$`, 'i'),
  descuento: new RegExp(`^(?:descuentos?|bonificaci[oó]n)\\s*:?\\s*-?\\s*\\$?\\s*(${MONTO})$`, 'i'),
  iva: new RegExp(`^iva(?:\\s*\\(?\\s*\\d+(?:[.,]\\d+)?\\s*%\\s*\\)?)?\\s*:?\\s*\\$?\\s*(${MONTO})$`, 'i'),
  total: new RegExp(`^total(?:\\s+general|\\s+a\\s+pagar)?\\s*:?\\s*\\$?\\s*(${MONTO})$`, 'i'),
}

/**
 * RF10.2 — lee del texto del comprobante los importes que figuran al pie:
 * subtotal, descuento, IVA y total. La suma de las lineas no es el total de la
 * factura, que ademas lleva descuentos e impuestos; sirve para contrastar una
 * contra la otra. Lo que no se encuentra queda en null; si no se encuentra nada,
 * devuelve null. El IVA de varias alicuotas se suma.
 */
export const extraerTotalesComprobante = (texto) => {
  if (!texto || typeof texto !== 'string') return null

  const totales = { subtotal: null, descuento: null, iva: null, total: null }
  for (const cruda of texto.split(/\r?\n/)) {
    // Ruido que el OCR deja antes de la etiqueta: simbolos o un par de letras con parentesis ("m) TOTAL")
    const linea = normalizarLineaOcr(cruda).replace(/^(?:[^\p{L}\d]+|\p{L}{1,2}\)\s*)+/u, '')
    for (const clave of Object.keys(RX_PIE)) {
      const m = linea.match(RX_PIE[clave])
      const importe = m ? parsearNumeroAr(m[1]) : null
      if (importe === null) continue
      totales[clave] = clave === 'iva' && totales.iva !== null ? redondear2(totales.iva + importe) : importe
    }
  }

  return Object.values(totales).some((v) => v !== null) ? totales : null
}

/**
 * RF10.3 — un producto dado de alta durante la validacion de una recepcion existe
 * solo para ella. Si la recepcion se elimina y el producto no tiene historia, no
 * hay motivo para que siga en el catalogo y en el mostrador con stock cero.
 * Es "de la recepcion" si se creo despues de registrarla, esta activo, sin
 * existencias y sin ningun uso: movimientos, ventas, pedidos, repuestos ni otras
 * recepciones. Un producto que ya estaba en el catalogo se conserva siempre.
 */
export const productoCreadoParaLaRecepcion = (producto, fechaRegistroRecepcion) => {
  if (!producto?.activo || Number(producto.stockActual) !== 0) return false

  const creado = new Date(producto.creadoEn)
  const registrada = new Date(fechaRegistroRecepcion)
  if (Number.isNaN(creado.getTime()) || Number.isNaN(registrada.getTime()) || creado < registrada) return false

  return ['movimientos', 'ventas', 'pedidos', 'repuestos', 'otrasRecepciones']
    .every((uso) => Number(producto[uso] ?? 0) === 0)
}

/**
 * Extrae palabras significativas para buscar sugerencias sobre el indice FULLTEXT
 * del catalogo en modo booleano sin exigir coincidencia estricta de cada token.
 */
export const consultaSugerenciaProducto = (descripcion) => {
  const texto = String(descripcion ?? '')
    .replace(/tipo\s+[c€]\b/gi, 'tipo c USB')
    .replace(/[€]/g, ' ')
  const palabras = texto
    .replace(/[+\-*~<>()"@.,:/\\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((p) => (p.length >= 3 || /^\d+[wWhHmMdD]$/.test(p)) && !PALABRAS_VACIAS.has(p.toLowerCase()))

  if (palabras.length === 0) return null
  return [...new Set(palabras)].slice(0, 8).map((p) => `${p}*`).join(' ')
}

// Palabras que no distinguen un producto de otro al comparar nombres.
const PALABRAS_GENERICAS = new Set([
  'de', 'la', 'el', 'para', 'con', 'sin', 'por', 'los', 'las', 'del', 'una', 'uno',
  'tipo', 'modelo', 'compatible', 'repuesto', 'generico',
])

const palabrasDe = (texto) =>
  String(texto ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/€/g, 'c')
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2 && !PALABRAS_GENERICAS.has(p))

// Tolera plurales, generos y palabras pegadas por el OCR:
// "baterias" ~ "bateria", "rapida" ~ "rapido", "fundasilicona" ~ "funda".
const coinciden = (a, b) =>
  a === b ||
  (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) ||
  (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5))

/**
 * RF10.2 — decide si un producto del catalogo se puede preseleccionar para una
 * linea leida por OCR. Una sugerencia equivocada es peor que ninguna: si se
 * confirma sin revisar, suma stock al producto equivocado y le pisa el costo.
 * Exige que la linea contenga al menos dos tercios de las palabras del nombre
 * del producto (y como minimo dos), y la marca si el nombre la incluye.
 */
export const productoSugerible = (descripcionOcr, { denominacion, marca }) => {
  const linea = palabrasDe(descripcionOcr)
  const producto = [...new Set(palabrasDe(denominacion))]
  if (producto.length === 0) return false

  const estaEnLinea = (palabra) => linea.some((otra) => coinciden(palabra, otra))
  // La marca y el modelo (A54, E20, S23: letras y despues numeros) son lo que
  // distingue un repuesto de otro. Las medidas (20W, 1M, 9H) no se exigen: el
  // OCR las confunde seguido ("1M" sale "im").
  const marcaEnNombre = palabrasDe(marca).filter((p) => producto.includes(p))
  const modelos = producto.filter((p) => /^[a-z]+\d/.test(p))
  if (!marcaEnNombre.every(estaEnLinea)) return false
  // El modelo se exige exacto: "a54" no es "a5" ni "a12".
  if (!modelos.every((modelo) => linea.includes(modelo))) return false

  const presentes = producto.filter(estaEnLinea).length
  return presentes >= Math.min(2, producto.length) && presentes / producto.length >= 2 / 3
}

// --- Encabezado del comprobante (RF10.2) -----------------------------------------

const sinAcentos = (texto) => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Tipo de comprobante: el primero que aparece entre "factura" y "remito". Un
 * comprobante con CAE o "autorizado por AFIP" es una factura aunque el OCR no
 * haya leido la palabra. "Recibo", "presupuesto" y "nota" quedan como OTRO. Sin
 * ninguna de esas senales no se decide: es mejor dejar el valor por defecto que
 * inventarlo.
 */
const leerTipo = (texto) => {
  const plano = sinAcentos(texto).toLowerCase()
  const factura = plano.search(/\bfactura\b/)
  const remito = plano.search(/\bremito\b/)
  if (factura >= 0 && (remito < 0 || factura < remito)) return 'FACTURA'
  if (remito >= 0) return 'REMITO'
  if (/\bcae\b|autorizado por afip/.test(plano)) return 'FACTURA'
  if (/\b(?:recibo|presupuesto|nota de)\b/.test(plano)) return 'OTRO'
  return null
}

/**
 * Numero de comprobante argentino: punto de venta de 4 o 5 digitos, guion y
 * numero de 6 a 8 ("0003-00024567"). El "N°" suele salir como "N*e" o "N*",
 * asi que no se depende de la etiqueta: se busca el patron.
 */
const leerNumero = (texto) => {
  const m = String(texto).match(/(?<![\d-])(\d{4,5})\s?[-–]\s?(\d{6,8})(?![\d-])/)
  return m ? `${m[1]}-${m[2]}` : null
}

const FECHA = /(?<!\d)(\d{1,2})\s?[/\-.]\s?(\d{1,2})\s?[/\-.]\s?(\d{4}|\d{2})(?!\d)/g

const aFechaIso = (dia, mes, anio, hoy) => {
  const d = Number(dia)
  const m = Number(mes)
  let a = Number(anio)
  if (a < 100) a += 2000
  const fecha = new Date(a, m - 1, d)
  const valida = fecha.getFullYear() === a && fecha.getMonth() === m - 1 && fecha.getDate() === d
  // Un comprobante no es del futuro ni de antes del 2000: si el OCR leyo cualquier
  // otro numero, se descarta en vez de cargar una fecha absurda.
  if (!valida || a < 2000 || fecha > hoy) return null
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** La fecha que sigue a "Fecha:"; si no hay etiqueta legible, la primera valida. */
const leerFecha = (texto, hoy) => {
  const lineas = String(texto).split(/\r?\n/)
  const conEtiqueta = lineas.filter((linea) => /fecha|emisi[oó]n/i.test(linea))
  for (const linea of [...conEtiqueta, ...lineas]) {
    for (const m of linea.matchAll(FECHA)) {
      const iso = aFechaIso(m[1], m[2], m[3], hoy)
      if (iso) return iso
    }
  }
  return null
}

const soloDigitos = (valor) => String(valor ?? '').replace(/\D/g, '')

/** CUIT con guiones ("30-71234567-8"), tal como lo imprime la factura. */
const leerCuits = (texto) => {
  const cuits = []
  for (const m of String(texto).matchAll(/(?<!\d)(\d{2})\s?[-–]\s?(\d{8})\s?[-–]\s?(\d)(?!\d)/g)) {
    const cuit = `${m[1]}${m[2]}${m[3]}`
    if (!cuits.includes(cuit)) cuits.push(cuit)
  }
  return cuits
}

const SUFIJO_SOCIETARIO = /\b(?:s\.?\s?r\.?\s?l\.?|s\.?\s?a\.?s?\.?)(?=\s|$)/i
const NO_ES_NOMBRE = /cuit|cuil|fecha|cliente|direcci[oó]n|domicilio|localidad|dni|iva|tel\b|nro|n[°º*]|cant|descripci|factura|remito|original|duplicado|hora|se[ñn]or|gracias|compra|total/i
// Lo que dice el membrete debajo del nombre: rubro y productos, no la razon social.
const RUBRO = new Set([
  'repuestos', 'accesorios', 'telefonia', 'celular', 'celulares', 'fundas', 'cargadores', 'auriculares',
  'baterias', 'protectores', 'insumos', 'mercaderia', 'detalle', 'venta', 'mayorista', 'minorista',
])

const limpiarRenglon = (cruda) => {
  const renglon = cruda
    .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9.&\s-]/g, ' ')
    .replace(/\bFACTURA\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Fuera las sobras de uno o dos caracteres del borde ("DJ", "a"), salvo S.A.
  const palabras = renglon.split(' ').filter(Boolean)
  while (palabras.length > 0 && palabras[0].length <= 2 && !/^s\.?a\.?$/i.test(palabras[0])) palabras.shift()
  // Y las de un caracter del borde derecho.
  while (palabras.length > 0 && palabras[palabras.length - 1].length === 1) palabras.pop()
  return palabras.join(' ')
}

const esNombrePlausible = (texto) => {
  const letras = (texto.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g) ?? []).length
  const palabras = sinAcentos(texto).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return (
    texto.length >= 5 && texto.length <= 60 && letras / texto.length >= 0.7 &&
    !NO_ES_NOMBRE.test(texto) && palabras.some((p) => p.length >= 4 && !RUBRO.has(p))
  )
}

/**
 * El nombre del proveedor es lo primero que imprime el comprobante, pero el OCR
 * deja basura en los bordes ("DJ", "| ", "a |") y los membretes mezclan el
 * nombre con el rubro. Solo se propone un nombre cuando hay una senal clara: la
 * etiqueta "Razon social", una terminacion S.R.L. o S.A., o un renglon entero en
 * mayusculas. Con menos que eso queda vacio: es mejor que lo escriba la persona
 * a que se cargue un proveedor con un nombre inventado por el ruido.
 */
const leerNombreProveedor = (texto) => {
  const renglones = String(texto).split(/\r?\n/)

  for (const cruda of renglones) {
    const m = cruda.match(/raz[oó]n\s+social\s*:?\s*(.+)$/i)
    const nombre = m ? limpiarRenglon(m[1]) : null
    if (nombre && esNombrePlausible(nombre)) return nombre
  }

  const candidatos = renglones.slice(0, 10).map(limpiarRenglon).filter(esNombrePlausible)
  return (
    candidatos.find((c) => SUFIJO_SOCIETARIO.test(c)) ??
    candidatos.find((c) => c === c.toUpperCase() && c.includes(' ')) ??
    null
  )
}

/**
 * RF10.2 — lo que la foto dice del comprobante: tipo, numero, fecha y quien lo
 * emite. Todo es una propuesta para que la persona revise: cada dato que no se
 * pudo leer con seguridad queda en null, no se adivina.
 *
 * @param {string} texto  el texto que devolvio el OCR
 * @param {Date} [hoy]    para descartar fechas del futuro
 */
export const extraerEncabezado = (texto, hoy = new Date()) => {
  const base = String(texto ?? '')
  return {
    tipoComprobante: leerTipo(base),
    numeroComprobante: leerNumero(base),
    fechaComprobante: leerFecha(base, hoy),
    cuits: leerCuits(base),
    nombreProveedor: leerNombreProveedor(base),
  }
}

// --- Proveedor ---------------------------------------------------------------------

// Palabras que no distinguen a un proveedor de otro.
const NOMBRE_GENERICO = new Set([
  'sa', 'srl', 'sas', 'sociedad', 'anonima', 'responsabilidad', 'limitada', 'distribuidora', 'comercial',
  'importadora', 'mayorista', 'hermanos', 'hnos', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'cia',
  'repuestos', 'accesorios', 'telefonia', 'celular', 'celulares',
])

const distancia = (a, b) => {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0]
    fila[0] = i
    for (let j = 1; j <= b.length; j++) {
      const guardado = fila[j]
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1))
      anterior = guardado
    }
  }
  return fila[b.length]
}

// "TecnoFx" es "TecnoFix" con una letra comida por el OCR; "TecnoCel" es otro
// proveedor aunque empiece igual. Se tolera un error cada cinco letras.
const parecidas = (a, b) =>
  a === b || (Math.min(a.length, b.length) >= 5 && distancia(a, b) <= Math.floor(Math.max(a.length, b.length) * 0.2))

const palabrasDistintivas = (nombre) =>
  sinAcentos(nombre).toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !NOMBRE_GENERICO.has(p))

/**
 * RF10.2 — busca entre los proveedores cargados al que emitio el comprobante.
 * Primero por CUIT, que no se confunde con nadie; si el OCR no lo leyo, por
 * nombre, exigiendo todas las palabras que lo distinguen. Si dos proveedores
 * encajan, no elige ninguno: equivocarse manda el stock y el costo a quien no es.
 *
 * @param {{cuits: string[]}} encabezado
 * @param {string} texto
 * @param {{idProveedor: number, nombre: string, cuit: string|null}[]} proveedores
 * @returns {null | {idProveedor: number, por: 'CUIT'|'NOMBRE'}}
 */
export const identificarProveedor = (encabezado, texto, proveedores) => {
  const porCuit = proveedores.filter((p) => {
    const cuit = soloDigitos(p.cuit)
    return cuit.length === 11 && encabezado.cuits.includes(cuit)
  })
  if (porCuit.length === 1) return { idProveedor: porCuit[0].idProveedor, por: 'CUIT' }
  if (porCuit.length > 1) return null

  const palabrasDelTexto = sinAcentos(String(texto).split(/\r?\n/).slice(0, 12).join(' '))
    .toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length >= 3)

  const porNombre = proveedores.filter((p) => {
    const distintivas = palabrasDistintivas(p.nombre)
    return distintivas.length > 0 && distintivas.every((d) => palabrasDelTexto.some((w) => parecidas(d, w)))
  })
  return porNombre.length === 1 ? { idProveedor: porNombre[0].idProveedor, por: 'NOMBRE' } : null
}
