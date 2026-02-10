# 🐳 Deployment con Docker - Palporro Racing

## Requisitos Previos
- Docker Desktop instalado y corriendo
- Tu API Key de Google Gemini

## 📋 Pasos para Deployment

### 1. Configurar Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```bash
VITE_GEMINI_API_KEY=tu_api_key_real_aqui
```

### 2. Construir y Ejecutar con Docker Compose

#### Opción A: Usando Docker Compose (Recomendado)

```bash
# Construir y levantar el contenedor
docker-compose up -d --build

# Ver logs
docker-compose logs -f

# Detener el contenedor
docker-compose down
```

#### Opción B: Usando Docker directamente

```bash
# Construir la imagen
docker build -t palporro-racing .

# Ejecutar el contenedor
docker run -d -p 8080:80 --name palporro-racing palporro-racing

# Ver logs
docker logs -f palporro-racing

# Detener el contenedor
docker stop palporro-racing
docker rm palporro-racing
```

### 3. Acceder a la Aplicación

Una vez que el contenedor esté corriendo, abre tu navegador en:

```
http://localhost:8080
```

Si estás en un servidor remoto, usa la IP del servidor:

```
http://IP_DEL_SERVIDOR:8080
```

## 🔧 Comandos Útiles

### Ver contenedores corriendo
```bash
docker ps
```

### Ver todos los contenedores
```bash
docker ps -a
```

### Ver logs en tiempo real
```bash
docker-compose logs -f palporro-racing
```

### Reiniciar el contenedor
```bash
docker-compose restart
```

### Reconstruir después de cambios
```bash
docker-compose up -d --build
```

### Eliminar todo (contenedor, imagen, volúmenes)
```bash
docker-compose down -v
docker rmi palporro-racing
```

## 🌐 Deployment en Servidor Remoto

### Opción 1: Copiar archivos al servidor

```bash
# En tu máquina local, comprimir el proyecto
tar -czf palporro-racing.tar.gz .

# Copiar al servidor (reemplaza USER y SERVER_IP)
scp palporro-racing.tar.gz USER@SERVER_IP:/ruta/destino/

# En el servidor, descomprimir
ssh USER@SERVER_IP
cd /ruta/destino/
tar -xzf palporro-racing.tar.gz

# Crear archivo .env con tu API key
echo "VITE_GEMINI_API_KEY=tu_api_key" > .env

# Levantar con Docker Compose
docker-compose up -d --build
```

### Opción 2: Usar Git

```bash
# En el servidor
git clone <tu-repositorio>
cd palporro-racing

# Crear .env
echo "VITE_GEMINI_API_KEY=tu_api_key" > .env

# Levantar
docker-compose up -d --build
```

## 🔒 Cambiar Puerto

Si quieres usar un puerto diferente, edita `docker-compose.yml`:

```yaml
ports:
  - "3000:80"  # Cambia 3000 por el puerto que prefieras
```

## 🚀 Optimizaciones de Producción

El Dockerfile incluye:
- ✅ Build multi-stage para imagen ligera
- ✅ Nginx para servir archivos estáticos
- ✅ Compresión Gzip
- ✅ Cache de assets estáticos
- ✅ Headers de seguridad
- ✅ Soporte para client-side routing

## 📊 Monitoreo

### Ver uso de recursos
```bash
docker stats palporro-racing
```

### Ver información del contenedor
```bash
docker inspect palporro-racing
```

## 🐛 Troubleshooting

### El contenedor no inicia
```bash
# Ver logs detallados
docker-compose logs palporro-racing
```

### Puerto ya en uso
```bash
# Cambiar el puerto en docker-compose.yml
# O detener el servicio que usa el puerto 8080
```

### Cambios no se reflejan
```bash
# Reconstruir forzando sin cache
docker-compose build --no-cache
docker-compose up -d
```

## 🔄 Actualizar la Aplicación

```bash
# Detener contenedor actual
docker-compose down

# Actualizar código (git pull o copiar archivos)
git pull

# Reconstruir y levantar
docker-compose up -d --build
```

