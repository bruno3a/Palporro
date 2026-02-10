# 🐳 Palporro Racing - Configuración Docker

## 📦 Archivos Creados

```
Palporro/
├── Dockerfile              # Configuración de la imagen Docker
├── docker-compose.yml      # Orquestación del contenedor
├── nginx.conf             # Configuración del servidor web
├── .dockerignore          # Archivos a ignorar en el build
├── deploy.ps1             # Script de deployment para Windows
├── deploy.sh              # Script de deployment para Linux/Mac
├── QUICK_START.md         # Guía rápida
├── DOCKER_DEPLOYMENT.md   # Documentación completa
└── .env                   # Variables de entorno (ya existía)
```

## 🎯 Características del Setup

### ✅ Optimizaciones Incluidas

- **Multi-stage build**: Imagen final ligera (~50MB con Nginx Alpine)
- **Nginx optimizado**: Compresión Gzip, cache de assets, headers de seguridad
- **Hot reload en desarrollo**: Vite sigue funcionando en local
- **Producción lista**: Build optimizado para deployment
- **Scripts automatizados**: Deployment con un solo comando

### 🔒 Seguridad

- Headers de seguridad configurados (X-Frame-Options, X-XSS-Protection, etc.)
- API Key en variables de entorno (no en el código)
- Nginx como reverse proxy

### ⚡ Performance

- Compresión Gzip para todos los assets
- Cache de 1 año para archivos estáticos
- No-cache para index.html (siempre la última versión)
- Imagen Docker optimizada

## 🚀 Uso Rápido

### Windows
```powershell
.\deploy.ps1
# Selecciona opción 1 para primera vez
```

### Linux/Mac
```bash
chmod +x deploy.sh
./deploy.sh
# Selecciona opción 1 para primera vez
```

### Manual
```bash
docker-compose up -d --build
```

## 🌐 Acceso

- **Local**: http://localhost:8080
- **Servidor**: http://IP_DEL_SERVIDOR:8080

## 📊 Arquitectura

```
┌─────────────────┐
│   Navegador     │
└────────┬────────┘
         │ HTTP :8080
         ▼
┌─────────────────┐
│  Docker Host    │
│  ┌───────────┐  │
│  │ Container │  │
│  │  Nginx    │  │
│  │  :80      │  │
│  │           │  │
│  │  /dist    │  │
│  │  (React)  │  │
│  └───────────┘  │
└─────────────────┘
```

## 🔄 Workflow de Desarrollo

1. **Desarrollo local**: `npm run dev` (puerto 3002)
2. **Test en Docker**: `docker-compose up -d --build`
3. **Deploy a servidor**: Copiar archivos + `docker-compose up -d --build`

## 📝 Notas Importantes

### Variables de Entorno

El archivo `.env` debe contener:
```
VITE_GEMINI_API_KEY=tu_api_key_aqui
```

**⚠️ IMPORTANTE**: 
- El `.env` NO se incluye en la imagen Docker por seguridad
- Debes crear el `.env` en cada servidor donde hagas deployment
- La API key se inyecta en tiempo de build

### Puertos

- **8080**: Puerto por defecto (configurable en docker-compose.yml)
- **80**: Puerto interno del contenedor (Nginx)

### Cambiar Puerto

Edita `docker-compose.yml`:
```yaml
ports:
  - "TU_PUERTO:80"  # Ejemplo: "3000:80"
```

## 🛠️ Comandos Útiles

```bash
# Ver logs en tiempo real
docker-compose logs -f

# Ver estado del contenedor
docker ps

# Reiniciar contenedor
docker-compose restart

# Detener y eliminar
docker-compose down

# Reconstruir sin cache
docker-compose build --no-cache

# Ver uso de recursos
docker stats palporro-racing
```

## 🐛 Troubleshooting

### Error: Puerto en uso
```bash
# Cambiar puerto en docker-compose.yml o detener el servicio que usa 8080
netstat -ano | findstr :8080  # Windows
lsof -i :8080                 # Linux/Mac
```

### Error: Docker no está corriendo
```bash
# Iniciar Docker Desktop y esperar a que esté completamente iniciado
```

### Cambios no se reflejan
```bash
# Reconstruir forzando
docker-compose down
docker-compose up -d --build
```

### Ver logs de errores
```bash
docker-compose logs palporro-racing
```

## 📚 Documentación Adicional

- **QUICK_START.md**: Inicio rápido en 3 pasos
- **DOCKER_DEPLOYMENT.md**: Guía completa de deployment
- **README.md**: Documentación general del proyecto

## 🎮 Código de Acceso Radio

Recuerda que el código de acceso por defecto para la sección Radio es: **1290**

---

**¿Necesitas ayuda?** Revisa DOCKER_DEPLOYMENT.md para instrucciones detalladas.

