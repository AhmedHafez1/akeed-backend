# Shopify App Store listing in Spanish

This is the Spanish translation of Akeed's Shopify App Store listing, ready to paste into the Partner Dashboard. It is not published by this repository: adding a translated listing is a manual step in the Partner Dashboard (see [How to add it](#how-to-add-it)).

## Before you add it

- **Add Spanish only when the app can be used in Spanish.** Shopify allows a language in the listing's Languages section only if merchants can use the app's interface in it (App Store requirement 4.3.2). The Spanish interface is the `es` locale of the frontend. Check it yourself in the embedded app first, and have a native Spanish speaker read it.
- **Spanish is an interface language only.** Customers still get their WhatsApp messages in Arabic or English. The listing below says so in App details, and must keep saying so. Do not add Spanish to any text about customer messages.
- **This replaces Shopify's automatic translation.** Shopify machine-translates the English listing into Spanish, and `https://apps.shopify.com/akeed?locale=es` shows that text with the notes "Contiene texto traducido automáticamente" and "Esta aplicación no está traducida al Español". A Spanish listing you add yourself replaces it. Deleting yours brings the automatic one back.
- **The English, Arabic and Urdu listings stay as they are.** Nothing below changes them.
- **Check the source text.** The Spanish fields follow the content of the live English listing. Compare each one with the English field in the Partner Dashboard before pasting, in case the English text has changed.
- **The wording is neutral Latin American Spanish.** It says "pago contra entrega" and keeps the acronym COD. Merchants in Spain also search for "contra reembolso", which is why that phrase is one of the search terms.

## Listing fields

Limits are Shopify's: app name 30 characters, introduction 100, details 500, each feature 80, and up to five search terms. The counts are characters, not bytes.

| Field | Spanish text | Characters |
| --- | --- | ---: |
| App name | Akeed: Confirmar pedidos COD | 28 of 30 |
| App card subtitle | Confirma pedidos contra entrega por WhatsApp antes de enviar. Reduce rechazos y devoluciones. | 93 |
| App introduction | Akeed confirma por WhatsApp cada pedido contra entrega antes del envío y evita envíos rechazados. | 97 of 100 |
| Feature 1 | Empieza sin conectar tu propio número de WhatsApp. | 50 of 80 |
| Feature 2 | Envía solicitudes de confirmación por WhatsApp en cada nuevo pedido COD. | 72 of 80 |
| Feature 3 | El cliente confirma o cancela con un toque y el pedido de Shopify se etiqueta. | 78 of 80 |
| Feature 4 | Ve pedidos confirmados, cancelados, pendientes y sin respuesta en un solo panel. | 80 of 80 |
| Feature 5 | Configura retraso de envío, recordatorio, horario de silencio y zona horaria. | 77 of 80 |

The English subtitle on the live listing is 89 characters. If the Partner Dashboard refuses the 93-character Spanish subtitle, use this shorter one (61 characters): Confirma pedidos contra entrega por WhatsApp antes de enviar.

### App details (497 of 500 characters)

> El cliente confirma o cancela con un toque y el pedido de Shopify se etiqueta solo. No necesitas conectar tu número de WhatsApp: los mensajes salen de la infraestructura oficial de WhatsApp de Akeed. Ve en un panel los pedidos confirmados, cancelados, pendientes y sin respuesta, y configura el retraso de envío, un recordatorio, el horario de silencio y la zona horaria. La interfaz de la app está en español, árabe, inglés y urdu; los clientes reciben los mensajes de WhatsApp en árabe o inglés.

The last sentence says: "The app interface is in Spanish, Arabic, English and Urdu; customers get WhatsApp messages in Arabic or English." Keep it.

## Pricing plans

Prices, message counts and plan order are the live ones and must not change. Plan names stay in English so they match the app's billing screens and Shopify's invoices.

| Plan | Price line | Spanish bullets |
| --- | --- | --- |
| Starter | Gratis | 30 mensajes de WhatsApp, una sola vez<br>Todas las funciones incluidas<br>Número oficial de WhatsApp de Akeed<br>Sin configuración, empieza en 1 minuto |
| Basic | $9.99 / mes | Todas las funciones de Starter<br>300 mensajes de WhatsApp incluidos<br>Todas las funciones incluidas |
| Pro | $22.99 / mes | Todas las funciones de Basic<br>1,000 mensajes de WhatsApp incluidos<br>Solo unos $0.023 por mensaje<br>Todas las funciones incluidas |
| Scale | $49.99 / mes | Todas las funciones de Pro<br>2,500 mensajes de WhatsApp incluidos<br>Solo $0.02 por mensaje<br>Todas las funciones incluidas |

A plan is shown to a merchant only if it has a description in the language they browse in, so every plan needs its Spanish text before the Spanish listing goes live.

Numbers are written as the app writes them in Spanish (`1,000`, `$0.023`). Shopify formats the plan price itself.

## Search terms

Search terms are not shown on the public listing, so these are proposals. Use the Spanish equivalents of the terms the English listing already has, at most five, each a complete word or phrase with one idea.

1. pago contra entrega
2. contra reembolso
3. confirmación de pedidos
4. WhatsApp
5. COD

## Not translated

- **Screenshots and the feature image** still show the English or Arabic interface. Replace them with Spanish screenshots when you have them, and write their alt text in Spanish.
- **Demo store, support email, privacy policy and FAQ links** are the same for every language.
- **Customer WhatsApp messages.** There is no Spanish message template. That is separate work: new templates, Meta approval and a new message-language option.

## How to add it

1. Open the Partner Dashboard and go to **App distribution > All apps > Akeed > Distribution > Manage listing**.
2. On the primary listing, add **Spanish** to the Languages section.
3. Choose **Add translated listing** and pick **Spanish**.
4. Paste each field from [Listing fields](#listing-fields) and [App details](#app-details-497-of-500-characters). Check the character counter under each field.
5. Paste the Spanish text of every plan from [Pricing plans](#pricing-plans).
6. Enter the search terms.
7. Save, then submit the listing if the dashboard asks for a review.
8. Open `https://apps.shopify.com/akeed?locale=es` in a private window and check that your text is shown and that the automatic-translation note is gone.

To take it back, open the Spanish listing and choose **More actions > Delete listing**, and remove Spanish from the Languages section. Shopify's automatic translation then shows again.

## Related

- The Spanish interface strings: `akeed-frontend/public/messages/es.json`.
- The Spanish help pages: `akeed-frontend/content/docs/es/`.
