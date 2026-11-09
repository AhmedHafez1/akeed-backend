# Production three-button template review

Drafts only. No provider submission, approval or activation is implied.

Text drafts: 23; image twin plans: 23.
Body blocks omit trailing spaces for readability. The JSON export preserves exact whitespace and includes providerBody with the exact Meta parameter syntax for manual adoption.

Review and submit text drafts in Admin > Templates, sync real provider results, and activate approved compatible counterparts without setting ordinary defaults. Review the image plans, then separately authorize Create missing twins (uploads/submits to Meta). Sync and activate usable approved twins. Own-number copies require independent text approval; image twins remain unsupported.

For manual Meta creation, use each exact provider name and language code below. Use the declared parameter format and variable order. Match body and buttons exactly; image twins add an IMAGE header to that text parent. Never invent a provider ID or mark an unapproved template as ready. Reconcile/adopt the exact name-language identity through the existing authorized workflow.

## ar / cod_confirm.ar.egyptian

- Draft key: cod_confirm.ar.change_bb861ea27ace3d05_v1
- Provider identity: akeed_cod_confirm_change_bb861ea27ace3d05_v1 [ar_EG]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.ar.change_bb861ea27ace3d05_v1_logo; akeed_cod_confirm_change_bb861ea27ace3d05_v1_logo; IMAGE; planned only
- Review finding: provider_button_labels_differ_from_preview

```text
أهلاً {{customer}} 👋

شكراً إنك اخترت *{{store}}*!
طلبك مستني تأكيدك عشان نشحنه.

رقم الطلب: {{order}}
الإجمالي: *{{total}}* (الدفع عند الاستلام)

اضغط "تأكيد الطلب" وهنشحنه على طول.
```

Provider body (use this exact parameter syntax in Meta):
```text
أهلاً {{customer}} 👋

شكراً إنك اخترت *{{store}}*!
طلبك مستني تأكيدك عشان نشحنه.

رقم الطلب: {{order}}
الإجمالي: *{{total}}* (الدفع عند الاستلام)

اضغط "تأكيد الطلب" وهنشحنه على طول.
```

Buttons: تأكيد الطلب → إلغاء الطلب → طلب تعديل

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "أحمد"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "متجر أكيد"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ar / cod_confirm.ar.gulf

- Draft key: cod_confirm.ar.change_67ccc3266f3e3c56_v1
- Provider identity: akeed_cod_confirm_change_67ccc3266f3e3c56_v1 [ar]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.ar.change_67ccc3266f3e3c56_v1_logo; akeed_cod_confirm_change_67ccc3266f3e3c56_v1_logo; IMAGE; planned only

```text
أهلاً {{customer}}،

طلبك رقم #{{order}} من {{store}} بانتظار تأكيدك.

ياليت تأكد الدفع عند الاستلام بقيمة {{total}} الحين عشان نطلعه للشحن فوراً وما يتأخر عليك.
```

Provider body (use this exact parameter syntax in Meta):
```text
أهلاً {{customer}}،

طلبك رقم #{{order}} من {{store}} بانتظار تأكيدك.

ياليت تأكد الدفع عند الاستلام بقيمة {{total}} الحين عشان نطلعه للشحن فوراً وما يتأخر عليك.
```

Buttons: اشحن طلبي → إلغاء → طلب تعديل

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "أحمد"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "متجر أكيد"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ar / cod_confirm.ar.short

- Draft key: cod_confirm.ar.change_897c6e34f7f6dea0_v1
- Provider identity: akeed_cod_confirm_change_897c6e34f7f6dea0_v1 [ar]
- Category: utility; format: positional; state: draft
- Twin: cod_confirm.ar.change_897c6e34f7f6dea0_v1_logo; akeed_cod_confirm_change_897c6e34f7f6dea0_v1_logo; IMAGE; planned only

```text
السلام عليكم

تم استلام طلبك رقم {{order}} والدفع عند الاستلام.
إجمالي السعر : {{total}}

من فضلك أكد الطلب.
```

Provider body (use this exact parameter syntax in Meta):
```text
السلام عليكم

تم استلام طلبك رقم {{1}} والدفع عند الاستلام.
إجمالي السعر : {{2}}

من فضلك أكد الطلب.
```

Buttons: تأكيد → إلغاء → طلب تعديل

Samples:
```json
[
  {
    "key": "order",
    "parameter": "1",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "2",
    "sample": "250.00 USD"
  }
]
```

## ar / cod_confirm.ar.standard

- Draft key: cod_confirm.ar.change_47d2a7dcffbca1d4_v1
- Provider identity: akeed_cod_confirm_change_47d2a7dcffbca1d4_v1 [ar]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.ar.change_47d2a7dcffbca1d4_v1_logo; akeed_cod_confirm_change_47d2a7dcffbca1d4_v1_logo; IMAGE; planned only

```text
أهلاً بك {{customer}}! 👋

شكراً لتسوقك من *{{store}}*

 طلبك رقم #{{order}} بقيمة {{total}} جاهز للشحن.

يرجى تأكيد الطلب لنتمكن من إرساله إليك بأسرع وقت.
```

Provider body (use this exact parameter syntax in Meta):
```text
أهلاً بك {{customer}}! 👋

شكراً لتسوقك من *{{store}}*

 طلبك رقم #{{order}} بقيمة {{total}} جاهز للشحن.

يرجى تأكيد الطلب لنتمكن من إرساله إليك بأسرع وقت.
```

Buttons: تأكيد الطلب → إلغاء الطلب → طلب تعديل

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "أحمد"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "متجر أكيد"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## en / cod_confirm.en.detailed_v1

- Draft key: cod_confirm.en.change_7c5cceb0fa9b08a7_v1
- Provider identity: akeed_cod_confirm_change_7c5cceb0fa9b08a7_v1 [en]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.en.change_7c5cceb0fa9b08a7_v1_logo; akeed_cod_confirm_change_7c5cceb0fa9b08a7_v1_logo; IMAGE; planned only

```text
Hello {{customer}},

Thanks for shopping with {{store}}!

Order Summary:

Order ID: #{{order}}
Cart Items: {{items}}
Total: {{total}}

Governorate or region: {{region}}
Address: {{address}}

Please confirm your order.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hello {{customer}},

Thanks for shopping with {{store}}!

Order Summary:

Order ID: #{{order}}
Cart Items: {{items}}
Total: {{total}}

Governorate or region: {{region}}
Address: {{address}}

Please confirm your order.
```

Buttons: Confirm → Cancel → Request a change

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ahmed"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Store"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "items",
    "parameter": "items",
    "sample": "1. Cotton shirt (1x 150) = 150, Color: Blue • 2. Sport socks (2x 50) = 100"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  },
  {
    "key": "region",
    "parameter": "region",
    "sample": "Cairo"
  },
  {
    "key": "address",
    "parameter": "address",
    "sample": "12 Nile Street, Maadi"
  }
]
```

## en / cod_confirm.en.direct

- Draft key: cod_confirm.en.change_8cad9e2cd9e9a238_v1
- Provider identity: akeed_cod_confirm_change_8cad9e2cd9e9a238_v1 [en]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.en.change_8cad9e2cd9e9a238_v1_logo; akeed_cod_confirm_change_8cad9e2cd9e9a238_v1_logo; IMAGE; planned only

```text
Hi {{customer}},

We are preparing your order #{{order}} at {{store}}.

Please confirm your COD total of {{total}} right now so we ship your order immediately.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hi {{customer}},

We are preparing your order #{{order}} at {{store}}.

Please confirm your COD total of {{total}} right now so we ship your order immediately.
```

Buttons: Ship My Order → Cancel → Request a change

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ahmed"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Store"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## en / cod_confirm.en.friendly

- Draft key: cod_confirm.en.change_baac0ce0da1bfe0b_v1
- Provider identity: akeed_cod_confirm_change_baac0ce0da1bfe0b_v1 [en]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.en.change_baac0ce0da1bfe0b_v1_logo; akeed_cod_confirm_change_baac0ce0da1bfe0b_v1_logo; IMAGE; planned only

```text
Hi {{customer}}! 👋

Thank you for shopping with *{{store}}*.

Your order {{order}} for the total amount of *{{total}}* is ready to go!

Please tap "Confirm Order" so we can ship it immediately.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hi {{customer}}! 👋

Thank you for shopping with *{{store}}*.

Your order {{order}} for the total amount of *{{total}}* is ready to go!

Please tap "Confirm Order" so we can ship it immediately.
```

Buttons: Confirm Order → Cancel Order → Request a change

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ahmed"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Store"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## en / cod_confirm.en.professional

- Draft key: cod_confirm.en.change_62f5d4a309be96b9_v1
- Provider identity: akeed_cod_confirm_change_62f5d4a309be96b9_v1 [en]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.en.change_62f5d4a309be96b9_v1_logo; akeed_cod_confirm_change_62f5d4a309be96b9_v1_logo; IMAGE; planned only

```text
Hello {{customer}},

Thank you for choosing {{store}}.

We have received your Cash on Delivery order #{{order}}.

To ensure a smooth delivery, please confirm your order for the total amount of {{total}}.

Once confirmed, We will ship your order.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hello {{customer}},

Thank you for choosing {{store}}.

We have received your Cash on Delivery order #{{order}}.

To ensure a smooth delivery, please confirm your order for the total amount of {{total}}.

Once confirmed, We will ship your order.
```

Buttons: Confirm & Ship → Cancel Order → Request a change

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ahmed"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Store"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## en / cod_confirm.en.short

- Draft key: cod_confirm.en.change_7baa5bf3c1b104b8_v1
- Provider identity: akeed_cod_confirm_change_7baa5bf3c1b104b8_v1 [en]
- Category: utility; format: positional; state: draft
- Twin: cod_confirm.en.change_7baa5bf3c1b104b8_v1_logo; akeed_cod_confirm_change_7baa5bf3c1b104b8_v1_logo; IMAGE; planned only

```text
Hello

We have received your order {{order}} with Cash on Delivery.
Total Price : {{total}}

Please confirm your order.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hello

We have received your order {{1}} with Cash on Delivery.
Total Price : {{2}}

Please confirm your order.
```

Buttons: Confirm → Cancel → Request a change

Samples:
```json
[
  {
    "key": "order",
    "parameter": "1",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "2",
    "sample": "250.00 USD"
  }
]
```

## es / cod_confirm.es.short_v1

- Draft key: cod_confirm.es.change_31a73e7d64e3b53d_v1
- Provider identity: akeed_cod_confirm_change_31a73e7d64e3b53d_v1 [es]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.es.change_31a73e7d64e3b53d_v1_logo; akeed_cod_confirm_change_31a73e7d64e3b53d_v1_logo; IMAGE; planned only

```text
¡Hola {{customer}}!

*{{store}}* ha recibido tu pedido n.º {{order}}.
El total es de *{{total}}*, que pagarás en efectivo al recibirlo.

Por favor, confirma tu pedido pulsando el botón de abajo.
```

Provider body (use this exact parameter syntax in Meta):
```text
¡Hola {{customer}}!

*{{store}}* ha recibido tu pedido n.º {{order}}.
El total es de *{{total}}*, que pagarás en efectivo al recibirlo.

Por favor, confirma tu pedido pulsando el botón de abajo.
```

Buttons: Confirmar → Cancelar → Solicitar un cambio

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Carlos"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Togo"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## es / cod_confirm.es.standard_v1

- Draft key: cod_confirm.es.change_2b42bac55099f36c_v1
- Provider identity: akeed_cod_confirm_change_2b42bac55099f36c_v1 [es]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.es.change_2b42bac55099f36c_v1_logo; akeed_cod_confirm_change_2b42bac55099f36c_v1_logo; IMAGE; planned only

```text
Hola, {{customer}}:

Hemos recibido tu pedido {{order}} en *{{store}}*. El total es de *{{total}}* y lo pagas al recibirlo.

Por favor, confirma tu pedido.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hola, {{customer}}:

Hemos recibido tu pedido {{order}} en *{{store}}*. El total es de *{{total}}* y lo pagas al recibirlo.

Por favor, confirma tu pedido.
```

Buttons: Confirmar pedido → Cancelar pedido → Solicitar un cambio

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Carlos"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Tienda Akeed"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## fr / cod_confirm.fr.short_v1

- Draft key: cod_confirm.fr.change_289d11d1d5daee9d_v1
- Provider identity: akeed_cod_confirm_change_289d11d1d5daee9d_v1 [fr]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.fr.change_289d11d1d5daee9d_v1_logo; akeed_cod_confirm_change_289d11d1d5daee9d_v1_logo; IMAGE; planned only

```text
Hello {{customer}} !

*{{store}}* a bien reçu votre commande n° {{order}}.
Le montant total est de *{{total}}*, à régler en espèces à la livraison.

Merci de confirmer votre commande en cliquant sur le bouton ci-dessous.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hello {{customer}} !

*{{store}}* a bien reçu votre commande n° {{order}}.
Le montant total est de *{{total}}*, à régler en espèces à la livraison.

Merci de confirmer votre commande en cliquant sur le bouton ci-dessous.
```

Buttons: Confirmer → Annuler → Demander une modification

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Zidane"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Togo"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## fr / cod_confirm.fr.standard_v1

- Draft key: cod_confirm.fr.change_78e66af78bf22ec6_v1
- Provider identity: akeed_cod_confirm_change_78e66af78bf22ec6_v1 [fr]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.fr.change_78e66af78bf22ec6_v1_logo; akeed_cod_confirm_change_78e66af78bf22ec6_v1_logo; IMAGE; planned only

```text
Bonjour {{customer}},

Nous avons bien reçu votre commande {{order}} sur *{{store}}*. Le total est de *{{total}}*, à payer à la livraison.

Merci de confirmer votre commande.
```

Provider body (use this exact parameter syntax in Meta):
```text
Bonjour {{customer}},

Nous avons bien reçu votre commande {{order}} sur *{{store}}*. Le total est de *{{total}}*, à payer à la livraison.

Merci de confirmer votre commande.
```

Buttons: Confirmer la commande → Annuler la commande → Demander une modification

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Camille"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Boutique Akeed"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## tr / cod_confirm.tr.short_v1

- Draft key: cod_confirm.tr.change_f6b2d208b708eda8_v1
- Provider identity: akeed_cod_confirm_change_f6b2d208b708eda8_v1 [tr]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.tr.change_f6b2d208b708eda8_v1_logo; akeed_cod_confirm_change_f6b2d208b708eda8_v1_logo; IMAGE; planned only

```text
Merhaba,
{{order}} numaralı siparişiniz alındı.
Toplam tutar {{total}}; ödeme kapıda yapılacaktır.
Lütfen onaylayın.
```

Provider body (use this exact parameter syntax in Meta):
```text
Merhaba,
{{order}} numaralı siparişiniz alındı.
Toplam tutar {{total}}; ödeme kapıda yapılacaktır.
Lütfen onaylayın.
```

Buttons: Onayla → İptal et → Değişiklik iste

Samples:
```json
[
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## tr / cod_confirm.tr.standard_v1

- Draft key: cod_confirm.tr.change_11e4f3829e38c9a4_v1
- Provider identity: akeed_cod_confirm_change_11e4f3829e38c9a4_v1 [tr]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.tr.change_11e4f3829e38c9a4_v1_logo; akeed_cod_confirm_change_11e4f3829e38c9a4_v1_logo; IMAGE; planned only

```text
Merhaba {{customer}},

*{{store}}* üzerinden verdiğiniz {{order}} numaralı siparişiniz alındı.
Toplam tutar *{{total}}*; ödeme kapıda yapılacaktır.

Lütfen siparişinizi onaylayın.
```

Provider body (use this exact parameter syntax in Meta):
```text
Merhaba {{customer}},

*{{store}}* üzerinden verdiğiniz {{order}} numaralı siparişiniz alındı.
Toplam tutar *{{total}}*; ödeme kapıda yapılacaktır.

Lütfen siparişinizi onaylayın.
```

Buttons: Siparişi onayla → Siparişi iptal et → Değişiklik iste

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ayşe"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Mağazası"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ur / cod_confirm.ur.short_v1

- Draft key: cod_confirm.ur.change_c6eb0ef5ddeae796_v1
- Provider identity: akeed_cod_confirm_change_c6eb0ef5ddeae796_v1 [ur]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.ur.change_c6eb0ef5ddeae796_v1_logo; akeed_cod_confirm_change_c6eb0ef5ddeae796_v1_logo; IMAGE; planned only

```text
السلام علیکم {{customer}}!

*{{store}}* پر آپ کا آرڈر نمبر {{order}} موصول ہو گیا ہے۔
کل رقم *{{total}}* ہے اور ادائیگی کیش آن ڈیلیوری کے ذریعے ہو گی۔

براہِ کرم نیچے دیے گئے بٹن پر کلک کر کے اپنے آرڈر کی تصدیق کریں۔
```

Provider body (use this exact parameter syntax in Meta):
```text
السلام علیکم {{customer}}!

*{{store}}* پر آپ کا آرڈر نمبر {{order}} موصول ہو گیا ہے۔
کل رقم *{{total}}* ہے اور ادائیگی کیش آن ڈیلیوری کے ذریعے ہو گی۔

براہِ کرم نیچے دیے گئے بٹن پر کلک کر کے اپنے آرڈر کی تصدیق کریں۔
```

Buttons: تصدیق کریں → منسوخ کریں → تبدیلی کی درخواست

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "أحمد"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Noor"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ur / cod_confirm.ur.standard_v1

- Draft key: cod_confirm.ur.change_dcbe1f47925efdd1_v1
- Provider identity: akeed_cod_confirm_change_dcbe1f47925efdd1_v1 [ur]
- Category: utility; format: named; state: draft
- Twin: cod_confirm.ur.change_dcbe1f47925efdd1_v1_logo; akeed_cod_confirm_change_dcbe1f47925efdd1_v1_logo; IMAGE; planned only

```text
السلام علیکم {{customer}}،

{{store}} پر آپ کا آرڈر *{{order}}* موصول ہو گیا ہے۔ کل رقم *{{total}}* ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔

براہِ کرم اپنے آرڈر کی تصدیق کریں۔
```

Provider body (use this exact parameter syntax in Meta):
```text
السلام علیکم {{customer}}،

{{store}} پر آپ کا آرڈر *{{order}}* موصول ہو گیا ہے۔ کل رقم *{{total}}* ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔

براہِ کرم اپنے آرڈر کی تصدیق کریں۔
```

Buttons: آرڈر کی تصدیق کریں → آرڈر منسوخ کریں → تبدیلی کی درخواست

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "احمد"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "اکید اسٹور"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ar / cod_reminder.ar.professional_v1

- Draft key: cod_reminder.ar.change_de47371c09f3f3f0_v1
- Provider identity: akeed_cod_reminder_change_de47371c09f3f3f0_v1 [ar]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.ar.change_de47371c09f3f3f0_v1_logo; akeed_cod_reminder_change_de47371c09f3f3f0_v1_logo; IMAGE; planned only

```text
مرحباً {{customer}}

نذكّرك بطلبك رقم {{order}} من *{{store}}* بقيمة *{{total}}* (الدفع عند الاستلام).

اضغط «تأكيد الطلب» ليبدأ المتجر بتجهيزه وشحنه، أو «إلغاء الطلب» إذا لم تعد ترغب به.
```

Provider body (use this exact parameter syntax in Meta):
```text
مرحباً {{customer}}

نذكّرك بطلبك رقم {{order}} من *{{store}}* بقيمة *{{total}}* (الدفع عند الاستلام).

اضغط «تأكيد الطلب» ليبدأ المتجر بتجهيزه وشحنه، أو «إلغاء الطلب» إذا لم تعد ترغب به.
```

Buttons: تأكيد الطلب → إلغاء الطلب → طلب تعديل

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "أحمد"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "متجر أكيد"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## en / cod_reminder.en.professional_v1

- Draft key: cod_reminder.en.change_d82cb1bc65fba168_v1
- Provider identity: akeed_cod_reminder_change_d82cb1bc65fba168_v1 [en]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.en.change_d82cb1bc65fba168_v1_logo; akeed_cod_reminder_change_d82cb1bc65fba168_v1_logo; IMAGE; planned only

```text
Hi {{customer}},

A quick reminder about your order {{order}} from *{{store}}*, total *{{total}}*, payable on delivery.

We haven't received your confirmation yet.

Tap "Confirm" so the store can prepare and ship it, or "Cancel" if you've changed your mind.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hi {{customer}},

A quick reminder about your order {{order}} from *{{store}}*, total *{{total}}*, payable on delivery.

We haven't received your confirmation yet.

Tap "Confirm" so the store can prepare and ship it, or "Cancel" if you've changed your mind.
```

Buttons: Confirm → Cancel → Request a change

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ahmed"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Store"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## es / cod_reminder.es.standard_v1

- Draft key: cod_reminder.es.change_d20418c9ca288b14_v1
- Provider identity: akeed_cod_reminder_change_d20418c9ca288b14_v1 [es]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.es.change_d20418c9ca288b14_v1_logo; akeed_cod_reminder_change_d20418c9ca288b14_v1_logo; IMAGE; planned only

```text
Hola, {{customer}}:

Tu pedido {{order}} en *{{store}}* sigue pendiente de confirmación. El total es de *{{total}}* y lo pagas al recibirlo.

Confírmalo para que podamos enviártelo.
```

Provider body (use this exact parameter syntax in Meta):
```text
Hola, {{customer}}:

Tu pedido {{order}} en *{{store}}* sigue pendiente de confirmación. El total es de *{{total}}* y lo pagas al recibirlo.

Confírmalo para que podamos enviártelo.
```

Buttons: Confirmar pedido → Cancelar pedido → Solicitar un cambio

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Carlos"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Tienda Akeed"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## fr / cod_reminder.fr.standard_v1

- Draft key: cod_reminder.fr.change_34d3aad33b9aea2c_v1
- Provider identity: akeed_cod_reminder_change_34d3aad33b9aea2c_v1 [fr]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.fr.change_34d3aad33b9aea2c_v1_logo; akeed_cod_reminder_change_34d3aad33b9aea2c_v1_logo; IMAGE; planned only

```text
Bonjour {{customer}},

Votre commande {{order}} sur *{{store}}* attend toujours votre confirmation. Le total est de *{{total}}*, à payer à la livraison.

Confirmez-la pour que nous puissions vous l'expédier.
```

Provider body (use this exact parameter syntax in Meta):
```text
Bonjour {{customer}},

Votre commande {{order}} sur *{{store}}* attend toujours votre confirmation. Le total est de *{{total}}*, à payer à la livraison.

Confirmez-la pour que nous puissions vous l'expédier.
```

Buttons: Confirmer la commande → Annuler la commande → Demander une modification

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Zidane"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Boutique Akeed"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## tr / cod_reminder.tr.standard_v1

- Draft key: cod_reminder.tr.change_26ba9baa5bd7ba60_v1
- Provider identity: akeed_cod_reminder_change_26ba9baa5bd7ba60_v1 [tr]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.tr.change_26ba9baa5bd7ba60_v1_logo; akeed_cod_reminder_change_26ba9baa5bd7ba60_v1_logo; IMAGE; planned only

```text
Merhaba {{customer}},

*{{store}}* üzerinden verdiğiniz {{order}} numaralı siparişiniz hâlâ onayınızı bekliyor.
Toplam tutar *{{total}}*; ödeme kapıda yapılacaktır.

Siparişinizi gönderebilmemiz için lütfen onaylayın.
```

Provider body (use this exact parameter syntax in Meta):
```text
Merhaba {{customer}},

*{{store}}* üzerinden verdiğiniz {{order}} numaralı siparişiniz hâlâ onayınızı bekliyor.
Toplam tutar *{{total}}*; ödeme kapıda yapılacaktır.

Siparişinizi gönderebilmemiz için lütfen onaylayın.
```

Buttons: Siparişi onayla → Siparişi iptal et → Değişiklik iste

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "Ayşe"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "Akeed Mağazası"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```

## ur / cod_reminder.ur.standard_v1

- Draft key: cod_reminder.ur.change_cde67dbdd8324986_v1
- Provider identity: akeed_cod_reminder_change_cde67dbdd8324986_v1 [ur]
- Category: utility; format: named; state: draft
- Twin: cod_reminder.ur.change_cde67dbdd8324986_v1_logo; akeed_cod_reminder_change_cde67dbdd8324986_v1_logo; IMAGE; planned only

```text
السلام علیکم {{customer}}،

*{{store}}* پر آپ کا آرڈر {{order}} ابھی آپ کی تصدیق کا منتظر ہے۔ کل رقم *{{total}}* ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔

تصدیق کر دیں تاکہ ہم آپ کا آرڈر روانہ کر سکیں۔
```

Provider body (use this exact parameter syntax in Meta):
```text
السلام علیکم {{customer}}،

*{{store}}* پر آپ کا آرڈر {{order}} ابھی آپ کی تصدیق کا منتظر ہے۔ کل رقم *{{total}}* ہے، ادائیگی کیش آن ڈیلیوری ہوگی۔

تصدیق کر دیں تاکہ ہم آپ کا آرڈر روانہ کر سکیں۔
```

Buttons: آرڈر کی تصدیق کریں → آرڈر منسوخ کریں → تبدیلی کی درخواست

Samples:
```json
[
  {
    "key": "customer",
    "parameter": "customer",
    "sample": "احمد"
  },
  {
    "key": "store",
    "parameter": "store",
    "sample": "اکید اسٹور"
  },
  {
    "key": "order",
    "parameter": "order",
    "sample": "TEST-1"
  },
  {
    "key": "total",
    "parameter": "total",
    "sample": "250.00 USD"
  }
]
```
