using SubtitleDb.Core;
using Xunit;

namespace SubtitleDb.Tests
{
    /// <summary>Regional tags resolve to the code the API files them under.</summary>
    public sealed class LanguageTests
    {
        // Checked live with ?lang= on 2026-10-18: these answer the ea files, the rest es.
        [Theory]
        [InlineData("es-419")]
        [InlineData("es-MX")]
        [InlineData("es-AR")]
        [InlineData("es-CO")]
        [InlineData("es-US")]
        [InlineData("es-PR")]
        [InlineData("es_MX")]
        [InlineData("es-Latn-MX")]
        public void LatinAmericanSpanishIsEa(string tag)
        {
            Assert.Equal("ea", Languages.ToCode(tag));
        }

        [Theory]
        [InlineData("es")]
        [InlineData("es-ES")]
        [InlineData("es-GQ")]
        [InlineData("es-013")]
        [InlineData("es-Latn")]
        [InlineData("ES-es")]
        [InlineData("spa")]
        public void AnyOtherSpanishIsEs(string tag)
        {
            Assert.Equal("es", Languages.ToCode(tag));
        }

        [Theory]
        [InlineData("pb", "Portuguese (Brazil)")]
        [InlineData("zt", "Chinese (Traditional)")]
        [InlineData("ze", "Chinese and English")]
        [InlineData("ea", "Spanish (Latin America)")]
        [InlineData("sp", "Spanish (Spain)")]
        [InlineData("pm", "Portuguese (Mozambique)")]
        public void TheCorpusCodesThatAreNotIsoHaveNames(string code, string name)
        {
            Assert.Equal(name, Languages.Name(code));
            Assert.Equal(code, Languages.ToCode(name));
        }

        [Fact]
        public void AScriptSubtagIsSkippedBeforeTheRegion()
        {
            Assert.Equal("zt", Languages.ToCode("zh-Hant-TW"));
            Assert.Equal("sr", Languages.ToCode("sr-Latn-RS"));
        }
    }
}
