# Despliegue de preproducción en JMFsrv

Este directorio reúne únicamente el procedimiento operativo. JMFsrv es un entorno temporal de preproducción; no es el destino definitivo de producción.

## Preparación única del servidor

1. Crear un directorio de aplicación privado, por ejemplo `/opt/assistent-esportiu`.
2. Clonar el repositorio en ese directorio.
3. Crear `.env` a partir de `.env.example` y definir `POSTGRES_PASSWORD`, `JWT_SECRET` y, cuando se active, la clave de IA.
4. Configurar el proxy existente del servidor hacia `127.0.0.1:8088`. La API no se publica directamente: permanece en `127.0.0.1:3000`.

## Actualización

Ejecutar desde el directorio del repositorio:

```sh
git pull --ff-only
docker compose -f docker-compose.preprod.yml up -d --build
docker compose -f docker-compose.preprod.yml ps
```

Comprobación de API:

```sh
curl http://127.0.0.1:3000/health
```

## Copias de seguridad

La primera iteración mantiene PostgreSQL en un volumen Docker local. Antes de abrir el piloto se programará un `pg_dump` diario fuera del volumen; al pasar a producción se migrará a PostgreSQL gestionado.
