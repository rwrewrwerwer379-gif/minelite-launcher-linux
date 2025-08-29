# MineLite Launcher (MVP)
Basit, akıcı ve minimalist bir Minecraft launcher. Popüler modları Modrinth üzerinden indirir, seçtiğiniz instance klasöründen Minecraft'ı başlatır/durdurur.

## Özellikler
- Kolay arayüz: Kullanıcı adı, sürüm, loader seçimi
- Instance klasörü ve Java yolu seçimi
- Minecraft'ı başlat/durdur
- Modrinth'ten popüler modları listele ve `mods/` klasörüne indir
- Günlük ve indirme ilerlemesi

> Not: Bu MVP sürümü "vanilla" başlatmayı kullanır. Fabric/Forge gibi yükleyici kurulumu otomatik değildir. Modları kullanmak için ilgili loader'ı manuel kurmanız gerekir.

## Gereksinimler
- Node.js 18+
- Java 17 (Minecraft 1.20.x için önerilir)

## Kurulum
```bash
npm install
npm start
```
Windows'ta Java yolunu otomatik bulamazsa, arayüzden `Java yolu` seçeneği ile `javaw.exe` dosyasını gösterin.

## Klasörler
- Instance (varsayılan): Kullanıcı klasörünüzde `.minelite/`
- Modlar: `mods/` alt klasörü

## İndir
- En güncel sürüm: https://github.com/rwrewrwerwer379-gif/MineLiteLauncher/releases/latest
- Windows için kurulum dosyası, Releases sayfasında "Assets" altında `.exe` olarak yer alır.

## Sorun Giderme
- Java bulunamadı: Java 17+ kurulu olduğundan emin olun ve `javaw.exe` yolunu seçin.
- Performans/ram: `src/main.js` içindeki `memory` ayarlarını düzenleyebilirsiniz.

## Lisans
MIT
