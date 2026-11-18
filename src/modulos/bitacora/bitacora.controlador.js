import { z } from 'zod'
import { leerPaginacion, responderPaginado } from '../../http/paginacion.js'
import { ACCIONES_BITACORA, sinCostos, sinDatosPersonales } from './bitacora.reglas.js'
import { puedeVerCosto } from '../catalogo/catalogo.reglas.js'
import { permisosDelUsuario } from '../../http/middlewares/autorizar.js'
import { listarBitacora } from './bitacora.servicio.js'

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato AAAA-MM-DD.')

const esquemaFiltros = z.object({
  desde: FECHA.optional(),
  hasta: FECHA.optional(),
  idUsuario: z.coerce.number().int().positive().optional(),
  entidad: z.string().trim().min(1).max(60).optional(),
  accion: z.enum(ACCIONES_BITACORA).optional(),
})

export const listar = async (peticion, respuesta) => {
  const paginacion = leerPaginacion(peticion.query)
  const filtros = esquemaFiltros.parse({
    desde: peticion.query.desde || undefined,
    hasta: peticion.query.hasta || undefined,
    idUsuario: peticion.query.idUsuario || undefined,
    entidad: peticion.query.entidad || undefined,
    accion: peticion.query.accion || undefined,
  })

  const resultado = await listarBitacora({ ...filtros, ...paginacion })

  // Los datos del negocio son del titular: quien no tiene acceso a Reportes no
  // ve costos ni montos, y quien no lo tiene a Clientes y proveedores no ve sus datos personales.
  const permisos = await permisosDelUsuario(peticion.usuario.idPerfil)
  const sinMontos = !puedeVerCosto(permisos)
  const sinPersonales = !permisos?.CLIENTES_PROV?.lectura
  if (sinMontos || sinPersonales) {
    const ocultar = (datos, entidad) => {
      let x = datos
      if (sinMontos) x = sinCostos(x)
      if (sinPersonales) x = sinDatosPersonales(x, entidad)
      return x
    }
    resultado.rows = resultado.rows.map((fila) => ({
      ...fila,
      datosAntes: ocultar(fila.datosAntes, fila.entidadAfectada),
      datosDespues: ocultar(fila.datosDespues, fila.entidadAfectada),
    }))
  }
  return respuesta.json(responderPaginado(resultado, paginacion))
}

