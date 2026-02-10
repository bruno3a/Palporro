#!/bin/bash

# Script de deployment para Palporro Racing
# Uso: ./deploy.sh

echo -e "\033[1;31m🏁 Palporro Racing - Docker Deployment\033[0m"
echo -e "\033[1;31m=======================================\033[0m"
echo ""

# Verificar que Docker esté corriendo
echo -e "\033[1;33mVerificando Docker...\033[0m"
if ! docker info > /dev/null 2>&1; then
    echo -e "\033[1;31m❌ Error: Docker no está corriendo\033[0m"
    echo -e "\033[1;33mPor favor, inicia Docker y vuelve a intentar\033[0m"
    exit 1
fi
echo -e "\033[1;32m✅ Docker está corriendo\033[0m"
echo ""

# Verificar archivo .env
echo -e "\033[1;33mVerificando archivo .env...\033[0m"
if [ ! -f .env ]; then
    echo -e "\033[1;31m❌ Error: No se encontró el archivo .env\033[0m"
    echo -e "\033[1;33mCrea un archivo .env con tu VITE_GEMINI_API_KEY\033[0m"
    echo -e "\033[1;36mEjemplo: VITE_GEMINI_API_KEY=tu_api_key_aqui\033[0m"
    exit 1
fi
echo -e "\033[1;32m✅ Archivo .env encontrado\033[0m"
echo ""

# Menú de opciones
echo -e "\033[1;36mSelecciona una opción:\033[0m"
echo "1. Construir y levantar contenedor (primera vez o después de cambios)"
echo "2. Levantar contenedor existente"
echo "3. Detener contenedor"
echo "4. Ver logs"
echo "5. Reconstruir desde cero (sin cache)"
echo "6. Eliminar todo y limpiar"
echo ""

read -p "Opción (1-6): " option

case $option in
    1)
        echo ""
        echo -e "\033[1;33m🔨 Construyendo y levantando contenedor...\033[0m"
        docker-compose up -d --build
        if [ $? -eq 0 ]; then
            echo ""
            echo -e "\033[1;32m✅ ¡Deployment exitoso!\033[0m"
            echo -e "\033[1;36m🌐 Accede a la aplicación en: http://localhost:8080\033[0m"
        fi
        ;;
    2)
        echo ""
        echo -e "\033[1;33m🚀 Levantando contenedor...\033[0m"
        docker-compose up -d
        if [ $? -eq 0 ]; then
            echo ""
            echo -e "\033[1;32m✅ Contenedor iniciado\033[0m"
            echo -e "\033[1;36m🌐 Accede a la aplicación en: http://localhost:8080\033[0m"
        fi
        ;;
    3)
        echo ""
        echo -e "\033[1;33m🛑 Deteniendo contenedor...\033[0m"
        docker-compose down
        echo -e "\033[1;32m✅ Contenedor detenido\033[0m"
        ;;
    4)
        echo ""
        echo -e "\033[1;33m📋 Mostrando logs (Ctrl+C para salir)...\033[0m"
        docker-compose logs -f
        ;;
    5)
        echo ""
        echo -e "\033[1;33m🔨 Reconstruyendo desde cero...\033[0m"
        docker-compose build --no-cache
        docker-compose up -d
        if [ $? -eq 0 ]; then
            echo ""
            echo -e "\033[1;32m✅ Reconstrucción exitosa\033[0m"
            echo -e "\033[1;36m🌐 Accede a la aplicación en: http://localhost:8080\033[0m"
        fi
        ;;
    6)
        echo ""
        echo -e "\033[1;31m⚠️  ADVERTENCIA: Esto eliminará el contenedor, imagen y volúmenes\033[0m"
        read -p "¿Estás seguro? (s/n): " confirm
        if [ "$confirm" = "s" ] || [ "$confirm" = "S" ]; then
            echo -e "\033[1;33m🗑️  Eliminando todo...\033[0m"
            docker-compose down -v
            docker rmi palporro-palporro-racing -f 2>/dev/null
            echo -e "\033[1;32m✅ Limpieza completada\033[0m"
        fi
        ;;
    *)
        echo -e "\033[1;31m❌ Opción inválida\033[0m"
        ;;
esac

echo ""

