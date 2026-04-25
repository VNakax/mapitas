# Modulo dos Mapitas

Modulo para Foundry VTT 13 que oferece um catalogo com preview e importacao sob demanda de cenas para o mundo atual.

## Instalacao pelo Foundry

Use este manifest na tela de instalacao de modulos:

`https://raw.githubusercontent.com/VNakax/mapitas/main/module.json`

O campo `download` do manifesto aponta para o asset de release `modulo-dos-mapitas.zip`, que deve conter a pasta do modulo na raiz do arquivo zipado.

## Instalacao manual

1. Copie a pasta `modulo-dos-mapitas` para `FoundryVTT/Data/modules/`.
2. Garanta que os assets estejam em `FoundryVTT/Data/Mapitas/czepeku/`.
3. Ative o modulo no mundo desejado.
4. Abra o navegador `Mapitas` no diretorio de cenas e importe apenas as cenas desejadas.

## Comportamento

- O modulo carrega um catalogo embutido, com nome, pasta, metadados e preview das cenas.
- A interface permite navegar por pastas, buscar por nome e importar uma cena sob demanda.
- A cena importada e criada diretamente no mundo atual, sem sincronizar toda a biblioteca.
- Quando a cena possui metadata no catalogo, o modulo reaproveita dimensoes, grid, walls, lights, drawings e notes.
- O preview usa thumbs leves embutidas no modulo; quando uma thumb nao existir, a UI faz fallback para o background da cena.

## Manutencao do catalogo

- O script `npm run extract:catalog` e uma ferramenta de manutencao para regenerar `catalog/` a partir do mundo-base `mapitas/`.
- O extrator aproveita os thumbs do proprio mundo-base em `mapitas/assets/scenes/` para preencher `catalog/previews/`.
- O fluxo normal de uso do modulo nao depende da pasta `mapitas/`.
- Extensoes suportadas para backgrounds: `webp`, `webm`, `png`, `jpg`, `jpeg`, `avif`, `apng`, `mp4`, `m4v`, `mov`.
