import { z } from 'zod'
import { leerPaginacion, responderPaginado } from '../../http/paginacion.js'
import {
  listarClientes, buscarCliente, listarTiposCliente,
  registrarCliente, modificarCliente, darDeBajaCliente,
  listarComprasCliente, listarReparacionesCliente,
} from './clientes.servicio.js'

const opcional = (esquema) => esquema.nullish().transform((valor) => valor || null)

const esquemaCliente = z.object({
  apellidoNombre: z.string().trim().min(2, 'El nombre necesita al menos dos caracteres.').max(150, 'El nombre es demasiado largo (máximo 150 caracteres).'),
  tipoPersona: z.enum(['FISICA', 'JURIDICA']).default('FISICA'),
  tipoDocumento: opcional(z.enum(['DNI', 'CUIT', 'CUIL', 'PASAPORTE', 'OTRO'])),
  numeroDocumento: opcional(z.string().trim().max(20, 'El número de documento es demasiado largo (máximo 20 caracteres).')),
  // H11: el WhatsApp es el dato de contacto que piden siempre.
  telefonoWhatsapp: opcional(z.string().trim()
    .max(30, 'El WhatsApp es demasiado largo (máximo 30 caracteres).')
    .regex(/^[\d\s+()\-.]*$/, 'El WhatsApp solo puede llevar números, espacios, +, guiones y paréntesis.')
    .refine((v) => !v || v.replace(/\D/g, '').length >= 6, 'El WhatsApp tiene que tener al menos 6 números.')),
  correo: opcional(z.string().trim().email('El correo no tiene un formato válido.').max(120, 'El correo es demasiado largo (máximo 120 caracteres).')),
  domicilio: opcional(z.string().trim().max(200, 'El domicilio es demasiado largo (máximo 200 caracteres).')),
  idTipoCliente: z.coerce.number().int().positive(),
  observaciones: opcional(z.string().trim().max(300, 'Las observaciones son demasiado largas (máximo 300 caracteres).')),
})

const esquemaId = z.coerce.number().int().positive()

export const listar = async (peticion, respuesta) => {
  const paginacion = leerPaginacion(peticion.query)
  const texto = z.string().trim().max(80).optional().parse(peticion.query.texto || undefined)

  const resultado = await listarClientes({
    texto,
    limit: paginacion.limit,
    offset: paginacion.offset,
  })

  return respuesta.json(responderPaginado(resultado, paginacion))
}

export const detalle = async (peticion, respuesta) => {
  const cliente = await buscarCliente(esquemaId.parse(peticion.params.idCliente))
  return respuesta.json({ datos: cliente })
}

export const tipos = async (_peticion, respuesta) =>
  respuesta.json({ datos: await listarTiposCliente() })

export const registrar = async (peticion, respuesta) => {
  const cliente = await registrarCliente(esquemaCliente.parse(peticion.body))
  return respuesta.status(201).json({ datos: cliente })
}

export const modificar = async (peticion, respuesta) => {
  const cliente = await modificarCliente(
    esquemaId.parse(peticion.params.idCliente),
    esquemaCliente.parse(peticion.body),
  )
  return respuesta.json({ datos: cliente })
}

export const darDeBaja = async (peticion, respuesta) => {
  await darDeBajaCliente(esquemaId.parse(peticion.params.idCliente))
  return respuesta.status(204).send()
}

export const comprasDelCliente = async (peticion, respuesta) => {
  const idCliente = esquemaId.parse(peticion.params.idCliente)
  const paginacion = leerPaginacion(peticion.query)
  const resultado = await listarComprasCliente(idCliente, paginacion)
  return respuesta.json(responderPaginado(resultado, paginacion))
}

export const reparacionesDelCliente = async (peticion, respuesta) => {
  const idCliente = esquemaId.parse(peticion.params.idCliente)
  const paginacion = leerPaginacion(peticion.query)
  const resultado = await listarReparacionesCliente(idCliente, paginacion)
  return respuesta.json(responderPaginado(resultado, paginacion))
}
