# Asistente Deportivo — Hoquei Club Sentmenat

Aplicación móvil instalable (PWA) para la coordinación y estrategia deportiva del club. La primera entrega cubre planificación y seguimiento colectivo de equipo, con una experiencia conversacional adaptada al rol de entrenador o coordinador.

## Arquitectura inicial

- **PWA**: interfaz móvil común para entrenadores y coordinación.
- **API Node.js / TypeScript**: autenticación, permisos, contexto deportivo y conexión con la IA.
- **PostgreSQL**: fuente central de usuarios, equipos, estrategia, planes y registros.
- **JMFsrv**: entorno temporal de preproducción mediante Docker Compose. No contiene credenciales en el cliente.

## Desarrollo local

1. Copia `.env.example` a `.env` y completa los secretos.
2. Instala las dependencias con `npm install`.
3. Ejecuta `npm run dev:api` y `npm run dev:web` en terminales separadas.

## Preproducción

El despliegue se ejecutará en JMFsrv con `docker compose -f docker-compose.preprod.yml up -d --build`. Antes de ello hay que crear el archivo `.env` únicamente en el servidor, con contraseñas y credenciales de IA.

La base PostgreSQL vive inicialmente en el mismo servidor de preproducción para acelerar el piloto. La configuración y los datos se han dejado separados para que la migración posterior a una base gestionada no afecte a la aplicación.

