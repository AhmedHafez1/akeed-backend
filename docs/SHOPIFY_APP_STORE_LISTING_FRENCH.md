# Shopify App Store listing in French

This is the French translation of Akeed's Shopify App Store listing, ready to paste into the Partner Dashboard. It is not published by this repository: adding a translated listing is a manual step in the Partner Dashboard (see [How to add it](#how-to-add-it)).

## Before you add it

- **Add French only when the app can be used in French.** Shopify allows a language in the listing's Languages section only if merchants can use the app's interface in it (App Store requirement 4.3.2). The French interface is the `fr` locale of the frontend. Check it yourself in the embedded app first, and have a native French speaker read it.
- **French is an interface language only.** Customers still get their WhatsApp messages in Arabic or English. The listing below says so in App details, and must keep saying so. Do not add French to any text about customer messages.
- **This replaces Shopify's automatic translation.** Shopify machine-translates the English listing into French, and `https://apps.shopify.com/akeed?locale=fr` shows that text with the notes "Contient du texte traduit automatiquement" and "Cette application n'est pas traduite en français". A French listing you add yourself replaces it. Deleting yours brings the automatic one back.
- **The English, Arabic, Urdu and Spanish listings stay as they are.** Nothing below changes them. Their App details name the interface languages; add French to that sentence in each of them when you next edit them, if you want them to agree.
- **Check the source text.** The French fields follow the content of the live English listing. Compare each one with the English field in the Partner Dashboard before pasting, in case the English text has changed.
- **The wording is standard French, as written in France.** It says "paiement à la livraison" and keeps the acronym COD, which merchants in North and West Africa also use. "Contre-remboursement" is the other common name, which is why it is one of the search terms.
- **The spaces are part of the text.** French puts a no-break space before `:`, `;`, `?` and `!`, and writes thousands as `1 000`. Those spaces are already in the text below, so copy it as it is and do not retype it.

## Listing fields

Limits are Shopify's: app name 30 characters, app card subtitle 62, introduction 100, details 500, each feature 80, and up to five search terms. The counts are characters, not bytes.

| Field | French text | Characters |
| --- | --- | ---: |
| App name | Akeed : Confirmation COD | 24 of 30 |
| App card subtitle | Confirmez vos commandes COD sur WhatsApp avant l’expédition. | 60 of 62 |
| App introduction | Confirmez sur WhatsApp les commandes en paiement à la livraison. Moins de refus et de retours. | 94 of 100 |
| Feature 1 | Commencez sans connecter votre propre numéro WhatsApp. | 54 of 80 |
| Feature 2 | Demande de confirmation WhatsApp automatique pour chaque nouvelle commande COD. | 79 of 80 |
| Feature 3 | Le client confirme ou annule d’un geste ; la commande Shopify est balisée. | 74 of 80 |
| Feature 4 | Commandes confirmées, annulées, en attente et sans réponse sur un seul écran. | 77 of 80 |
| Feature 5 | Réglez délai d’envoi, rappel de relance, heures de silence et fuseau horaire. | 77 of 80 |

The app name keeps the brand first, as the English name does. If the Partner Dashboard asks for the same name in every language, keep the English name and paste the rest.

### App details (490 of 500 characters)

> Akeed vérifie sur WhatsApp chaque commande en paiement à la livraison avant son traitement, pour ne plus payer l’expédition de fausses commandes. Le client confirme ou annule d’un geste et la commande Shopify est balisée automatiquement. Aucun numéro WhatsApp personnel requis. Un tableau de bord suit chaque statut ; rappel, heures de silence et délai d’envoi sont réglables. Interface en français, arabe, anglais, ourdou et espagnol ; messages WhatsApp aux clients en arabe ou en anglais.

The last sentence says: "Interface in French, Arabic, English, Urdu and Spanish; WhatsApp messages to customers in Arabic or English." Keep it.

## Pricing plans

Prices, message counts and plan order are the live ones and must not change. Plan names stay in English so they match the app's billing screens and Shopify's invoices.

| Plan | Price line | French bullets |
| --- | --- | --- |
| Starter | Gratuit | 30 messages WhatsApp, une seule fois.<br>Toutes les fonctionnalités incluses.<br>Numéro WhatsApp officiel d’Akeed.<br>Aucune configuration. Démarrez en 1 minute. |
| Basic | $9.99 / mois | Toutes les fonctionnalités de Starter.<br>300 messages WhatsApp inclus.<br>Toutes les fonctionnalités incluses. |
| Pro | $22.99 / mois | Toutes les fonctionnalités de Basic.<br>1 000 messages WhatsApp inclus.<br>Environ 0,023 $ seulement par message.<br>Toutes les fonctionnalités incluses. |
| Scale | $49.99 / mois | Toutes les fonctionnalités de Pro.<br>2 500 messages WhatsApp inclus.<br>Seulement 0,02 $ par message.<br>Toutes les fonctionnalités incluses. |

A plan is shown to a merchant only if it has a description in the language they browse in, so every plan needs its French text before the French listing goes live.

Shopify formats the plan price itself, so the price line is shown here as the App Store prints it. Numbers inside the bullets are written the French way (`1 000`, `0,023 $`), as the app writes them in French.

## Search terms

Search terms are not shown on the public listing, so these are proposals. Use the French equivalents of the terms the English listing already has, at most five, each a complete word or phrase with one idea.

1. paiement à la livraison
2. contre-remboursement
3. confirmation de commande
4. WhatsApp
5. COD

## Not translated

- **Screenshots and the feature image** still show the English or Arabic interface. Replace them with French screenshots when you have them, and write their alt text in French.
- **Demo store, support email, privacy policy and FAQ links** are the same for every language.
- **Customer WhatsApp messages.** There is no French message template. That is separate work: new templates, Meta approval and a new message-language option.

## How to add it

1. Open the Partner Dashboard and go to **App distribution > All apps > Akeed > Distribution > Manage listing**.
2. On the primary listing, add **French** to the Languages section.
3. Choose **Add translated listing** and pick **French**.
4. Paste each field from [Listing fields](#listing-fields) and [App details](#app-details-490-of-500-characters). Check the character counter under each field.
5. Paste the French text of every plan from [Pricing plans](#pricing-plans).
6. Enter the search terms.
7. Save, then submit the listing if the dashboard asks for a review.
8. Open `https://apps.shopify.com/akeed?locale=fr` in a private window and check that your text is shown and that the automatic-translation note is gone.

To take it back, open the French listing and choose **More actions > Delete listing**, and remove French from the Languages section. Shopify's automatic translation then shows again.

## Related

- The French interface strings: `akeed-frontend/public/messages/fr.json`.
- The French help pages: `akeed-frontend/content/docs/fr/`.
