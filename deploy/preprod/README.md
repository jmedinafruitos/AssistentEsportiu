# Despliegue de preproducción en JMFsrv

Este directorio reúne únicamente el procedimiento operativo. JMFsrv es un entorno temporal de preproducción; no es el destino definitivo de producción.

## Preparación única del servidor

1. Clonar el repositorio en un directorio de aplicación privado. En la
   instancia actual es `/home/jordi/assistent-esportiu-preprod`, con
   `origin` apuntando directamente a GitHub — no asumir `/opt/...`, verificar
   con `git remote -v` en el propio servidor si se reinstala en otro sitio.
2. Crear `.env` a partir de `.env.example` y definir `POSTGRES_PASSWORD`, `JWT_SECRET` y, cuando se active, la clave de IA.
3. Publicar `127.0.0.1:8088` hacia fuera. En la instancia actual esto es
   **Tailscale Serve** (`tailscale serve status` debe mostrar
   `/ proxy http://127.0.0.1:8088`), no nginx — el único site nginx activo
   en este servidor pertenece a otro proyecto (`eulaliavila`). La API no se
   publica directamente: permanece en `127.0.0.1:3000`.

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
