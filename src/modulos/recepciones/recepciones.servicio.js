import { access, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Op, QueryTypes } from 'sequelize'
import { sequelize } from '../../config/base-de-datos.js'
import {
  RecepcionMercaderia,
  OcrExtraccion,
  DetalleRecepcion,
  Proveedor,
  Persona,
  Producto,
  Usuario,
} from '../../modelos/index.js'
import { registrarIngreso } from '../existencias/existencias.servicio.js'
import { registrarEnBitacora } from '../bitacora/bitacora.servicio.js'
import { inicioDeDia, finDeDia } from '../../http/fechas.js'
import { DatosInvalidos, NoEncontrado } from '../../errores.js'
import { registroDe } from '../../registro.js'
import { CARPETA_COMPROBANTES } from './comprobantes.js'
import { procesarImagenOcr } from './ocr.js'
import { guardarAnalisis, verAnalisis, consumirAnalisis } from './analisis-pendientes.js'
import {
  extraerLineas,
  calcularTotalRecepcion,
  consultaSugerenciaProducto,
  productoSugerible,
  extraerEncabezado,
  extraerTotalesComprobante,
  identificarProveedor,
  productoCreadoParaLaRecepcion,
} from './recepciones.reglas.js'

const log = registroDe('recepciones')

const CONFIANZA_MINIMA_SUGERENCIA = 40

const RELACIONES_RECEPCION = [
  {
    model: Proveedor,
    as: 'proveedor',
    attributes: ['idProveedor'],
    include: [{ model: Persona, as: 'persona', attributes: ['apellidoNombre', 'numeroDocumento'] }],
  },
  { model: Usuario, as: 'usuario', attributes: ['idUsuario', 'nombreUsuario'] },
  {
    model: OcrExtraccion,
    as: 'extraccion',
    attributes: [
      'idExtraccion',
      'fechaProcesamiento',
      'motorOcr',
      'textoExtraido',
      'confianzaPromedio',
      'estado',
      'mensajeError',
    ],
  },
  {
    model: DetalleRecepcion,
    as: 'lineas',
    // RF04.2: nunca exponemos producto.precioCosto en recepciones; solo el
    // costo declarado en el comprobante (DetalleRecepcion.precioCosto).
    include: [{
      model: Producto,
      as: 'producto',
      attributes: ['idProducto', 'codigoInterno', 'denominacion', 'stockActual'],
    }],
  },
]

const formatearRecepcion = (r) => ({
  idRecepcion: r.idRecepcion,
  idProveedor: r.idProveedor,
  proveedor: r.proveedor
    ? {
        idProveedor: r.proveedor.idProveedor,
        nombre: r.proveedor.persona?.apellidoNombre ?? 'Sin nombre',
        cuit: r.proveedor.persona?.numeroDocumento ?? null,
      }
    : null,
  usuario: r.usuario ? { idUsuario: r.usuario.idUsuario, nombreUsuario: r.usuario.nombreUsuario } : null,
  tipoComprobante: r.tipoComprobante,
  numeroComprobante: r.numeroComprobante,
  fechaComprobante: r.fechaComprobante,
  fechaRegistro: r.fechaRegistro,
  origenCarga: r.origenCarga,
  tieneImagen: Boolean(r.imagenComprobante),
  estado: r.estado,
  // Suma de las lineas. El total de la factura (con descuento e IVA) es otro dato:
  // se lee del pie del comprobante, y solo hay uno si la recepcion vino de una foto.
  montoTotal: Number(r.montoTotal ?? 0),
  totalesComprobante: extraerTotalesComprobante(r.extraccion?.textoExtraido),
  fechaConfirmacion: r.fechaConfirmacion,
  extraccion: r.extraccion
    ? {
        idExtraccion: r.extraccion.idExtraccion,
        fechaProcesamiento: r.extraccion.fechaProcesamiento,
        motorOcr: r.extraccion.motorOcr,
        textoExtraido: r.extraccion.textoExtraido,
        confianzaPromedio: r.extraccion.confianzaPromedio !== null
          ? Number(r.extraccion.confianzaPromedio)
          : null,
        estado: r.extraccion.estado,
        mensajeError: r.extraccion.mensajeError,
      }
    : null,
  lineas: (r.lineas ?? []).map((l) => ({
    idDetalleRecepcion: l.idDetalleRecepcion,
    idProducto: l.idProducto,
    producto: l.producto
      ? {
          idProducto: l.producto.idProducto,
          codigoInterno: l.producto.codigoInterno,
          denominacion: l.producto.denominacion,
          stockActual: Number(l.producto.stockActual ?? 0),
        }
      : null,
    descripcionOriginal: l.descripcionOriginal,
    cantidad: Number(l.cantidad),
    precioCosto: Number(l.precioCosto),
    validado: Boolean(l.validado),
  })),
})

const verificarProveedor = async (idProveedor, transaction) => {
  const proveedor = await Proveedor.findOne({
    where: { idProveedor, activo: true },
    include: [{ model: Persona, as: 'persona', attributes: ['apellidoNombre'] }],
    transaction,
  })
  if (!proveedor) throw new NoEncontrado('El proveedor')
  return proveedor
}

const verificarProductosActivos = async (lineas, transaction) => {
  const ids = [...new Set(lineas.map((l) => l.idProducto).filter(Boolean))]
  if (ids.length === 0) return

  const encontrados = await Producto.findAll({
    where: { idProducto: ids, activo: true },
    attributes: ['idProducto'],
    transaction,
  })
  if (encontrados.length !== ids.length) {
    throw new NoEncontrado('Uno de los productos indicados')
  }
}

const manejarDuplicadoComprobante = (error) => {
  if (error?.name === 'SequelizeUniqueConstraintError') {
    throw new DatosInvalidos(
      'Ya existe una recepción con ese tipo y número de comprobante para el proveedor seleccionado.',
    )
  }
  throw error
}

/**
 * Busca la mejor sugerencia en el catalogo usando el indice FULLTEXT que ya
 * usa la busqueda de productos. El FULLTEXT trae candidatos con que coincida
 * una sola palabra; de los mejores se toma el primero que pase
 * productoSugerible. Si ninguno pasa, la linea queda sin producto y el
 * usuario lo elige o lo crea.
 */
const sugerirProductoFulltext = async (descripcion) => {
  const consulta = consultaSugerenciaProducto(descripcion)
  if (!consulta) return null

  const [candidatos] = await sequelize.query(`
    SELECT p.id_producto AS idProducto,
           p.denominacion,
           m.nombre AS marca,
           MATCH (p.denominacion, p.descripcion) AGAINST (:consulta IN BOOLEAN MODE) AS relevancia
      FROM producto p
      JOIN marca m ON m.id_marca = p.id_marca
     WHERE p.activo = 1
       AND MATCH (p.denominacion, p.descripcion) AGAINST (:consulta IN BOOLEAN MODE)
     ORDER BY relevancia DESC
     LIMIT 5
  `, { replacements: { consulta } })

  return candidatos.find((candidato) => productoSugerible(descripcion, candidato))?.idProducto ?? null
}

/** RF10.1 — alta manual de recepcion en estado PENDIENTE_VALIDACION. */
export const crearRecepcionManual = async (datos, idUsuario) => {
  const { idProveedor, tipoComprobante, numeroComprobante, fechaComprobante, lineas } = datos

  let idRecepcion
  try {
    idRecepcion = await sequelize.transaction(async (transaction) => {
      await verificarProveedor(idProveedor, transaction)
      await verificarProductosActivos(lineas, transaction)

      const montoTotal = calcularTotalRecepcion(lineas)
      const recepcion = await RecepcionMercaderia.create({
        idProveedor,
        idUsuario,
        tipoComprobante,
        numeroComprobante: numeroComprobante || null,
        fechaComprobante: fechaComprobante || null,
        origenCarga: 'MANUAL',
        estado: 'PENDIENTE_VALIDACION',
        montoTotal,
      }, { transaction })

      await DetalleRecepcion.bulkCreate(
        lineas.map((l) => ({
          idRecepcion: recepcion.idRecepcion,
          idProducto: l.idProducto,
          descripcionOriginal: null,
          cantidad: l.cantidad,
          precioCosto: l.precioCosto,
          validado: false,
        })),
        { transaction },
      )

      return recepcion.idRecepcion
    })
  } catch (error) {
    manejarDuplicadoComprobante(error)
  }

  log.info({ idRecepcion, usuario: idUsuario }, 'recepcion manual registrada')
  return buscarRecepcion(idRecepcion)
}

/**
 * RF10.2 — primer paso de la recepcion con foto: lee el comprobante en el
 * servidor y devuelve lo que encontro, sin crear nada todavia. La foto ya
 * subida y el analisis quedan guardados un rato (analisis-pendientes.js) hasta
 * que la persona confirma y se crea la recepcion.
 *
 * Que proveedor emitio el comprobante se decide aca porque la recepcion no puede
 * existir sin uno: si esta cargado, se propone; si no, se devuelve el nombre y el
 * CUIT leidos para darlo de alta con un clic, como pasa con los productos.
 */
export const analizarComprobante = async (archivo, idUsuario) => {
  try {
    const resultadoOcr = await procesarImagenOcr(archivo.path)
    const texto = resultadoOcr.ok ? String(resultadoOcr.texto ?? '') : ''
    const lineasExtraidas = resultadoOcr.ok
      ? (resultadoOcr.lineas ?? extraerLineas(texto))
      : []

    const encabezado = extraerEncabezado(texto)
    const proveedores = await listarProveedoresActivos()
    const identificado = identificarProveedor(encabezado, texto, proveedores)

    const lineas = []
    const sugerir = resultadoOcr.ok && (resultadoOcr.confianza ?? 0) >= CONFIANZA_MINIMA_SUGERENCIA
    for (const linea of lineasExtraidas) {
      const idProducto = sugerir
        ? await sugerirProductoFulltext(linea.descripcionOriginal).catch(() => null)
        : null
      lineas.push({
        idProducto,
        descripcionOriginal: linea.descripcionOriginal,
        cantidad: linea.cantidad,
        precioCosto: linea.precioCosto,
        validado: false,
      })
    }

    guardarAnalisis({
      archivo: archivo.filename,
      ruta: archivo.path,
      idUsuario,
      analisis: { resultadoOcr, lineas },
    })

    const propuesto = encabezado.nombreProveedor || encabezado.cuits[0]
    log.info({
      archivo: archivo.filename,
      ok: resultadoOcr.ok,
      confianza: resultadoOcr.confianza,
      proveedor: identificado?.por ?? null,
      lineas: lineas.length,
    }, 'comprobante analizado')

    return {
      archivo: archivo.filename,
      ok: resultadoOcr.ok,
      error: resultadoOcr.error,
      confianza: resultadoOcr.confianza,
      encabezado: {
        tipoComprobante: encabezado.tipoComprobante,
        numeroComprobante: encabezado.numeroComprobante,
        fechaComprobante: encabezado.fechaComprobante,
      },
      proveedor: identificado
        ? {
            idProveedor: identificado.idProveedor,
            nombre: proveedores.find((p) => p.idProveedor === identificado.idProveedor).nombre,
            por: identificado.por,
          }
        : null,
      proveedorPropuesto: !identificado && propuesto
        ? { nombre: encabezado.nombreProveedor, cuit: encabezado.cuits[0] ?? null }
        : null,
      cantidadLineas: lineas.length,
    }
  } catch (error) {
    await unlink(archivo.path).catch(() => {})
    throw error
  }
}

/**
 * RF10.2 — segundo paso: crea la recepcion con el analisis de la foto y los datos
 * que la persona confirmo o corrigio (proveedor, tipo, numero y fecha). Si el
 * motor fallo o la foto era mala, la recepcion queda igual con la extraccion en
 * estado ERROR para que se carguen las lineas a mano.
 *
 * Si algo falla (por ejemplo, el comprobante ya estaba cargado) el analisis se
 * conserva: se corrige el dato y se vuelve a intentar sin subir la foto de nuevo.
 */
export const crearRecepcionOcr = async (
  { archivo, idProveedor, tipoComprobante, numeroComprobante, fechaComprobante },
  idUsuario,
) => {
  const { resultadoOcr, lineas } = verAnalisis(archivo, idUsuario)

  let idRecepcion
  try {
    idRecepcion = await sequelize.transaction(async (transaction) => {
      await verificarProveedor(idProveedor, transaction)

      const recepcion = await RecepcionMercaderia.create({
        idProveedor,
        idUsuario,
        tipoComprobante,
        numeroComprobante: numeroComprobante || null,
        fechaComprobante: fechaComprobante || null,
        origenCarga: 'OCR',
        imagenComprobante: archivo,
        estado: 'PENDIENTE_VALIDACION',
        montoTotal: calcularTotalRecepcion(lineas),
      }, { transaction })

      await OcrExtraccion.create({
        idRecepcion: recepcion.idRecepcion,
        motorOcr: resultadoOcr.motor,
        textoExtraido: resultadoOcr.texto,
        confianzaPromedio: resultadoOcr.confianza,
        estado: resultadoOcr.ok ? 'PROCESADO' : 'ERROR',
        mensajeError: resultadoOcr.error,
      }, { transaction })

      if (lineas.length > 0) {
        await DetalleRecepcion.bulkCreate(
          lineas.map((linea) => ({ ...linea, idRecepcion: recepcion.idRecepcion })),
          { transaction },
        )
      }

      return recepcion.idRecepcion
    })
  } catch (error) {
    manejarDuplicadoComprobante(error)
  }

  consumirAnalisis(archivo)
  log.info({ idRecepcion, confianza: resultadoOcr.confianza, lineas: lineas.length }, 'recepcion OCR creada')

  return buscarRecepcion(idRecepcion)
}

export const listarRecepciones = async ({ estado, idProveedor, desde, hasta, limit, offset }) => {
  const where = {}
  if (estado && estado !== 'TODAS') where.estado = estado
  if (idProveedor) where.idProveedor = idProveedor
  if (desde || hasta) {
    where.fechaRegistro = {
      ...(desde ? { [Op.gte]: inicioDeDia(desde) } : {}),
      ...(hasta ? { [Op.lte]: finDeDia(hasta) } : {}),
    }
  }

  const resultado = await RecepcionMercaderia.findAndCountAll({
    where,
    include: [
      {
        model: Proveedor,
        as: 'proveedor',
        attributes: ['idProveedor'],
        include: [{ model: Persona, as: 'persona', attributes: ['apellidoNombre'] }],
      },
      { model: Usuario, as: 'usuario', attributes: ['idUsuario', 'nombreUsuario'] },
      { model: OcrExtraccion, as: 'extraccion', attributes: ['confianzaPromedio', 'estado'] },
    ],
    order: [['fechaRegistro', 'DESC'], ['idRecepcion', 'DESC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  })

  return {
    count: resultado.count,
    rows: resultado.rows.map((r) => ({
      idRecepcion: r.idRecepcion,
      idProveedor: r.idProveedor,
      proveedor: r.proveedor?.persona?.apellidoNombre ?? 'Sin nombre',
      usuario: r.usuario?.nombreUsuario ?? null,
      tipoComprobante: r.tipoComprobante,
      numeroComprobante: r.numeroComprobante,
      fechaComprobante: r.fechaComprobante,
      fechaRegistro: r.fechaRegistro,
      origenCarga: r.origenCarga,
      estado: r.estado,
      montoTotal: Number(r.montoTotal ?? 0),
      confianzaOcr: r.extraccion?.confianzaPromedio !== null && r.extraccion?.confianzaPromedio !== undefined
        ? Number(r.extraccion.confianzaPromedio)
        : null,
      estadoOcr: r.extraccion?.estado ?? null,
    })),
  }
}

export const buscarRecepcion = async (idRecepcion) => {
  const recepcion = await RecepcionMercaderia.findByPk(idRecepcion, {
    include: RELACIONES_RECEPCION,
    order: [[{ model: DetalleRecepcion, as: 'lineas' }, 'idDetalleRecepcion', 'ASC']],
  })
  if (!recepcion) throw new NoEncontrado('La recepción')
  return formatearRecepcion(recepcion)
}

export const rutaImagenComprobante = async (idRecepcion) => {
  const recepcion = await RecepcionMercaderia.findByPk(idRecepcion, {
    attributes: ['idRecepcion', 'imagenComprobante'],
  })
  if (!recepcion || !recepcion.imagenComprobante) {
    throw new NoEncontrado('La imagen del comprobante')
  }

  const ruta = join(CARPETA_COMPROBANTES, recepcion.imagenComprobante)
  try {
    await access(ruta)
  } catch {
    throw new NoEncontrado('La imagen del comprobante')
  }
  return ruta
}

/** RF10.3 — edita las lineas mientras la recepcion esta pendiente. */
export const actualizarLineas = async (idRecepcion, lineas) => {
  let productosDadosDeBaja = []

  await sequelize.transaction(async (transaction) => {
    const recepcion = await RecepcionMercaderia.findByPk(idRecepcion, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    })
    if (!recepcion) throw new NoEncontrado('La recepción')
    if (recepcion.estado !== 'PENDIENTE_VALIDACION') {
      throw new DatosInvalidos('Solo se pueden editar las líneas de una recepción pendiente de validación.')
    }

    await verificarProductosActivos(lineas, transaction)

    const anteriores = await DetalleRecepcion.findAll({ where: { idRecepcion }, attributes: ['idProducto'], transaction })
    await DetalleRecepcion.destroy({ where: { idRecepcion }, transaction })
    if (lineas.length > 0) {
      await DetalleRecepcion.bulkCreate(
        lineas.map((l) => ({
          idRecepcion,
          idProducto: l.idProducto ?? null,
          descripcionOriginal: l.descripcionOriginal ?? null,
          cantidad: l.cantidad,
          precioCosto: l.precioCosto,
          validado: false,
        })),
        { transaction },
      )
    }

    await recepcion.update({ montoTotal: calcularTotalRecepcion(lineas) }, { transaction })

    // Lo que se quita de la recepcion no se queda en el catalogo: se da de baja el
    // producto que se habia creado para esa linea, si ya no lo usa nadie.
    const siguen = new Set(lineas.map((l) => l.idProducto).filter(Boolean))
    const quitados = anteriores.map((l) => l.idProducto).filter((idProducto) => idProducto && !siguen.has(idProducto))
    productosDadosDeBaja = await darDeBajaProductosSobrantes(quitados, recepcion.fechaRegistro, 'se quitó de una recepción', transaction)
  })

  return { ...(await buscarRecepcion(idRecepcion)), productosDadosDeBaja }
}

/** RF10.3 — confirmacion atomica: existencias, costos y bitacora en una transaccion. */
export const confirmarRecepcion = async (idRecepcion, idUsuario) => {
  await sequelize.transaction(async (transaction) => {
    const recepcion = await RecepcionMercaderia.findByPk(idRecepcion, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    })
    if (!recepcion) throw new NoEncontrado('La recepción')
    if (recepcion.estado !== 'PENDIENTE_VALIDACION') {
      throw new DatosInvalidos('Esa recepción ya fue confirmada o anulada.')
    }

    const proveedor = await verificarProveedor(recepcion.idProveedor, transaction)

    const lineas = await DetalleRecepcion.findAll({
      where: { idRecepcion },
      order: [['idDetalleRecepcion', 'ASC']],
      transaction,
    })
    if (lineas.length === 0) {
      throw new DatosInvalidos('La recepción no tiene líneas cargadas para confirmar.')
    }

    const sinProducto = lineas
      .map((l, idx) => (!l.idProducto ? (l.descripcionOriginal || `Línea #${idx + 1}`) : null))
      .filter(Boolean)
    if (sinProducto.length > 0) {
      throw new DatosInvalidos(
        `Falta asociar producto en: ${sinProducto.slice(0, 5).join(', ')}${sinProducto.length > 5 ? '…' : ''}.`,
      )
    }

    const comprobante = `${recepcion.tipoComprobante}${recepcion.numeroComprobante ? ` ${recepcion.numeroComprobante}` : ` #${recepcion.idRecepcion}`}`
    const nombreProveedor = proveedor.persona?.apellidoNombre ?? `Proveedor #${proveedor.idProveedor}`

    await registrarIngreso({
      lineas: lineas.map((l) => ({ idProducto: l.idProducto, cantidad: l.cantidad })),
      observaciones: `Recepción ${comprobante} — ${nombreProveedor}`.slice(0, 200),
      idRecepcion: recepcion.idRecepcion,
    }, idUsuario, transaction)

    for (const linea of lineas) {
      await Producto.update(
        { precioCosto: linea.precioCosto },
        { where: { idProducto: linea.idProducto, activo: true }, transaction },
      )
    }

    await DetalleRecepcion.update(
      { validado: true },
      { where: { idRecepcion }, transaction },
    )

    const montoTotal = calcularTotalRecepcion(lineas)
    await recepcion.update({
      montoTotal,
      estado: 'CONFIRMADA',
      fechaConfirmacion: new Date(),
    }, { transaction })

    await registrarEnBitacora({
      entidad: 'recepcion_mercaderia',
      idRegistro: recepcion.idRecepcion,
      accion: 'ALTA',
      despues: {
        idProveedor: recepcion.idProveedor,
        proveedor: nombreProveedor,
        comprobante,
        lineas: lineas.length,
        montoTotal,
      },
      detalle: `${nombreProveedor} · ${comprobante} (${lineas.length} líneas)`,
    }, transaction)
  })

  log.info({ idRecepcion, usuario: idUsuario }, 'recepcion confirmada')
  return buscarRecepcion(idRecepcion)
}

/**
 * RF10.3 — elimina una recepcion pendiente. Una recepcion cargada por error
 * (o leida mal) no debe quedar ocupando su numero de comprobante: la base lo
 * exige unico por proveedor, y la factura real no se podria volver a cargar.
 * Solo se eliminan las pendientes, que todavia no movieron stock. Las lineas y
 * la extraccion OCR se borran en cascada. La recepcion completa queda en la
 * bitacora, y la foto se conserva en el almacen como respaldo de ese registro.
 *
 * Los productos que se dieron de alta solo para esta recepcion y no tienen
 * historia se dan de baja: si no, quedarian en el catalogo y en el mostrador con
 * stock cero. Devuelve cuales fueron, para avisarlo.
 */
export const eliminarRecepcion = async (idRecepcion) => {
  let productosDadosDeBaja = []

  await sequelize.transaction(async (transaction) => {
    const recepcion = await RecepcionMercaderia.findByPk(idRecepcion, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    })
    if (!recepcion) throw new NoEncontrado('La recepción')
    if (recepcion.estado !== 'PENDIENTE_VALIDACION') {
      throw new DatosInvalidos('Solo se puede eliminar una recepción pendiente de validación.')
    }

    const completa = await RecepcionMercaderia.findByPk(idRecepcion, {
      include: RELACIONES_RECEPCION,
      order: [[{ model: DetalleRecepcion, as: 'lineas' }, 'idDetalleRecepcion', 'ASC']],
      transaction,
    })
    const copia = { ...formatearRecepcion(completa), imagenComprobante: completa.imagenComprobante }
    const comprobante = `${copia.tipoComprobante} ${copia.numeroComprobante ?? `#${copia.idRecepcion}`}`

    await registrarEnBitacora({
      entidad: 'recepcion_mercaderia',
      idRegistro: recepcion.idRecepcion,
      accion: 'BAJA',
      antes: copia,
      despues: null,
      detalle: `Recepción eliminada: ${comprobante} de ${copia.proveedor?.nombre ?? 'proveedor sin nombre'}`,
    }, transaction)

    await recepcion.destroy({ transaction })

    const ids = (completa.lineas ?? []).map((l) => l.idProducto).filter(Boolean)
    productosDadosDeBaja = await darDeBajaProductosSobrantes(ids, completa.fechaRegistro, 'la recepción se eliminó', transaction)
  })

  log.info({ idRecepcion, productosDadosDeBaja: productosDadosDeBaja.length }, 'recepcion pendiente eliminada')
  return { productosDadosDeBaja }
}

// Da de baja, de entre `idsProducto`, los que se crearon solo para esa recepcion y
// quedaron sin ningun uso. Se corre con las lineas ya actualizadas (o borradas en
// cascada): si una linea todavia usa el producto, cuenta como uso y se conserva.
const darDeBajaProductosSobrantes = async (idsProducto, fechaRegistro, motivo, transaction) => {
  const ids = [...new Set(idsProducto)]
  if (ids.length === 0) return []

  const candidatos = await sequelize.query(
    `SELECT p.id_producto AS idProducto, p.denominacion, p.activo, p.stock_actual AS stockActual,
            p.creado_en AS creadoEn,
            (SELECT COUNT(*) FROM movimiento_stock x WHERE x.id_producto = p.id_producto) AS movimientos,
            (SELECT COUNT(*) FROM detalle_venta x WHERE x.id_producto = p.id_producto) AS ventas,
            (SELECT COUNT(*) FROM pedido_pendiente x WHERE x.id_producto = p.id_producto) AS pedidos,
            (SELECT COUNT(*) FROM repuesto_utilizado x WHERE x.id_producto = p.id_producto) AS repuestos,
            (SELECT COUNT(*) FROM detalle_recepcion x WHERE x.id_producto = p.id_producto) AS otrasRecepciones
       FROM producto p
      WHERE p.id_producto IN (:ids)`,
    { replacements: { ids }, type: QueryTypes.SELECT, transaction },
  )

  const sobrantes = candidatos.filter((p) => productoCreadoParaLaRecepcion(p, fechaRegistro))
  for (const producto of sobrantes) {
    await Producto.update({ activo: false }, { where: { idProducto: producto.idProducto }, transaction })
    await registrarEnBitacora({
      entidad: 'producto',
      idRegistro: producto.idProducto,
      accion: 'BAJA',
      antes: { activo: true, denominacion: producto.denominacion },
      despues: { activo: false },
      detalle: `${producto.denominacion} · creado para una recepción y ${motivo}`,
    }, transaction)
  }

  return sobrantes.map((p) => ({ idProducto: p.idProducto, denominacion: p.denominacion }))
}

export const listarProveedoresActivos = async () => {
  const filas = await Proveedor.findAll({
    where: { activo: true },
    attributes: ['idProveedor'],
    include: [{ model: Persona, as: 'persona', attributes: ['apellidoNombre', 'numeroDocumento'] }],
    order: [[{ model: Persona, as: 'persona' }, 'apellidoNombre', 'ASC']],
  })
  return filas.map((p) => ({
    idProveedor: p.idProveedor,
    nombre: p.persona?.apellidoNombre ?? `Proveedor #${p.idProveedor}`,
    cuit: p.persona?.numeroDocumento ?? null,
  }))
}
