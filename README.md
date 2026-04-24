# Modulo dos Mapitas

Modulo para Foundry VTT 13 que sincroniza a pasta `Data/Mapitas` em um compendium de cenas do mundo atual.

## Instalacao pelo Foundry

Use este manifest na tela de instalacao de modulos:

`https://raw.githubusercontent.com/VNakax/mapitas/main/module.json`

O campo `download` do manifesto aponta para o asset de release `modulo-dos-mapitas.zip`, que deve conter a pasta do modulo na raiz do arquivo zipado.

## Instalacao manual

1. Copie a pasta `modulo-dos-mapitas` para `FoundryVTT/Data/modules/`.
2. Garanta que os mapas estejam em `FoundryVTT/Data/Mapitas/`.
3. Ative o modulo no mundo desejado.
4. Aguarde a primeira sincronizacao e importe as cenas do compendium `Mapitas`.

## Comportamento

- O modulo procura arquivos suportados dentro de `Data/Mapitas`.
- O compendium criado e do tipo `Scene` e pertence ao mundo atual.
- Cada arquivo gera uma cena importavel apontando para o asset original em `Data/Mapitas`.
- Novos arquivos sao adicionados e arquivos removidos saem do compendium na proxima sincronizacao.
- Na primeira execucao em cada mundo, o modulo pede confirmacao antes de iniciar e pode limpar o compendium atual antes de reimportar.
- A sincronizacao ocorre em lotes menores com pausas curtas entre operacoes para reduzir picos de requests no Foundry.
- Durante a sincronizacao, o modulo mantem uma barra fixa no topo com progresso resumido, sem log detalhado por mapa.
- O nome das cenas prioriza a pasta amigavel do mapa e acrescenta apenas variantes uteis, como `Night` ou `Gridless`.
- O nome exibido da cena decodifica segmentos como `%20` para que espacos e outros caracteres aparecam de forma legivel.
- Para mapas em imagem, o modulo reutiliza o proprio arquivo como `thumb` da cena para evitar geracao automatica de thumbnail quando possivel.

## Observacoes

- A primeira sincronizacao pode demorar bastante em bibliotecas grandes.
- Sincronizacoes seguintes reutilizam as cenas ja existentes e tendem a ser bem mais leves.
- Extensoes suportadas: `webp`, `webm`, `png`, `jpg`, `jpeg`, `avif`, `apng`, `mp4`, `m4v`, `mov`.
