# Script de deployment para Palporro Racing
# Uso: .\deploy.ps1

Write-Host "🏁 Palporro Racing - Docker Deployment" -ForegroundColor Red
Write-Host "=======================================" -ForegroundColor Red
Write-Host ""

# Verificar que Docker esté corriendo
Write-Host "Verificando Docker Desktop..." -ForegroundColor Yellow
$dockerRunning = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error: Docker Desktop no está corriendo" -ForegroundColor Red
    Write-Host "Por favor, inicia Docker Desktop y vuelve a intentar" -ForegroundColor Yellow
    exit 1
}
Write-Host "✅ Docker está corriendo" -ForegroundColor Green
Write-Host ""

# Verificar archivo .env
Write-Host "Verificando archivo .env..." -ForegroundColor Yellow
if (-not (Test-Path .env)) {
    Write-Host "❌ Error: No se encontró el archivo .env" -ForegroundColor Red
    Write-Host "Crea un archivo .env con tu VITE_GEMINI_API_KEY" -ForegroundColor Yellow
    Write-Host "Ejemplo: VITE_GEMINI_API_KEY=tu_api_key_aqui" -ForegroundColor Cyan
    exit 1
}
Write-Host "✅ Archivo .env encontrado" -ForegroundColor Green
Write-Host ""

# Preguntar qué hacer
Write-Host "Selecciona una opción:" -ForegroundColor Cyan
Write-Host "1. Construir y levantar contenedor (primera vez o después de cambios)"
Write-Host "2. Levantar contenedor existente"
Write-Host "3. Detener contenedor"
Write-Host "4. Ver logs"
Write-Host "5. Reconstruir desde cero (sin cache)"
Write-Host "6. Eliminar todo y limpiar"
Write-Host ""

$option = Read-Host "Opción (1-6)"

switch ($option) {
    "1" {
        Write-Host ""
        Write-Host "🔨 Construyendo y levantando contenedor..." -ForegroundColor Yellow
        docker-compose up -d --build
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✅ ¡Deployment exitoso!" -ForegroundColor Green
            Write-Host "🌐 Accede a la aplicación en: http://localhost:8080" -ForegroundColor Cyan
        }
    }
    "2" {
        Write-Host ""
        Write-Host "🚀 Levantando contenedor..." -ForegroundColor Yellow
        docker-compose up -d
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✅ Contenedor iniciado" -ForegroundColor Green
            Write-Host "🌐 Accede a la aplicación en: http://localhost:8080" -ForegroundColor Cyan
        }
    }
    "3" {
        Write-Host ""
        Write-Host "🛑 Deteniendo contenedor..." -ForegroundColor Yellow
        docker-compose down
        Write-Host "✅ Contenedor detenido" -ForegroundColor Green
    }
    "4" {
        Write-Host ""
        Write-Host "📋 Mostrando logs (Ctrl+C para salir)..." -ForegroundColor Yellow
        docker-compose logs -f
    }
    "5" {
        Write-Host ""
        Write-Host "🔨 Reconstruyendo desde cero..." -ForegroundColor Yellow
        docker-compose build --no-cache
        docker-compose up -d
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✅ Reconstrucción exitosa" -ForegroundColor Green
            Write-Host "🌐 Accede a la aplicación en: http://localhost:8080" -ForegroundColor Cyan
        }
    }
    "6" {
        Write-Host ""
        Write-Host "⚠️  ADVERTENCIA: Esto eliminará el contenedor, imagen y volúmenes" -ForegroundColor Red
        $confirm = Read-Host "¿Estás seguro? (s/n)"
        if ($confirm -eq "s" -or $confirm -eq "S") {
            Write-Host "🗑️  Eliminando todo..." -ForegroundColor Yellow
            docker-compose down -v
            docker rmi palporro-palporro-racing -f 2>$null
            Write-Host "✅ Limpieza completada" -ForegroundColor Green
        }
    }
    default {
        Write-Host "❌ Opción inválida" -ForegroundColor Red
    }
}

Write-Host ""

