# 🏁 Palporro Racing - Quick Start con Docker

## 🚀 Inicio Rápido (3 pasos)

### 1️⃣ Asegúrate de tener tu API Key

Verifica que tu archivo `.env` tenga tu API key de Gemini:

```bash
VITE_GEMINI_API_KEY=tu_api_key_real
```

### 2️⃣ Ejecuta el script de deployment

**En Windows (PowerShell):**
```powershell
.\deploy.ps1
```

**En Linux/Mac:**
```bash
chmod +x deploy.sh
./deploy.sh
```

### 3️⃣ Accede a la aplicación

Abre tu navegador en: **http://localhost:8080**

---

## 📝 Comandos Manuales (si prefieres no usar el script)

### Construir y levantar
```bash
docker-compose up -d --build
```

### Ver logs
```bash
docker-compose logs -f
```

### Detener
```bash
docker-compose down
```

---

## 🌐 Deployment en Servidor Remoto

### Opción 1: Docker Desktop en el servidor

1. Copia todos los archivos del proyecto al servidor
2. Asegúrate de tener el archivo `.env` con tu API key
3. Ejecuta: `docker-compose up -d --build`
4. Accede desde: `http://IP_DEL_SERVIDOR:8080`

### Opción 2: Cambiar puerto

Edita `docker-compose.yml` y cambia:
```yaml
ports:
  - "TU_PUERTO:80"  # Ejemplo: "3000:80"
```

---

## 🔧 Troubleshooting

### Puerto 8080 ya está en uso
Edita `docker-compose.yml` y cambia el puerto (ejemplo: `3000:80`)

### Docker no está corriendo
Abre Docker Desktop y espera a que inicie completamente

### Cambios no se reflejan
```bash
docker-compose down
docker-compose up -d --build
```

---

## 📚 Documentación Completa

Para instrucciones detalladas, consulta: **DOCKER_DEPLOYMENT.md**

